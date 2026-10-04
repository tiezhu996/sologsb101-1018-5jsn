/**
 * /paint 漆料批次台账与领用对账
 * 髹涂、镶嵌两个工序共用同一漆料批次：登记领用并与台账余量对账；
 * 供应商通报批次停用时先预览受影响的胎体 / 道次 / 打磨 / 镶嵌 / 质检，
 * 确认后原子冻结下游记录（原值保留），同一通报只生成一份召回单，重启后续处理。
 * 消费 PaintBatch、PaintUsage、RecallOrder 及全部下游模型；复用 <StatBadge>、<EmptyPanel>、<FrozenTag>。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  AuditOutlined,
  CloudServerOutlined,
  ExperimentOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FrozenTag from '@/components/common/FrozenTag';
import StatBadge from '@/components/common/StatBadge';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useIdbTable } from '@/hooks/useIdbTable';
import { usePaintStore } from '@/stores/paintStore';
import { useRoomStore } from '@/stores/roomStore';
import { BODY_SHAPE_LABEL } from '@/types/body';
import { COAT_STATE_LABEL, PAINT_TYPE_LABEL } from '@/types/coat';
import { UNTRACED_BATCH_ID, UNTRACED_BATCH_LABEL } from '@/types/freeze';
import { INLAY_TYPE_LABEL } from '@/types/inlay';
import {
  PAINT_BATCH_STATUS_LABEL,
  PAINT_KIND_LABEL,
  PAINT_KIND_OPTIONS,
  PAINT_UNIT_LABEL,
  PAINT_UNIT_OPTIONS,
  RECALL_STATUS_LABEL,
  USAGE_PROCESS_LABEL,
  USAGE_PROCESS_OPTIONS,
  createEmptyPaintBatchDraft,
  type PaintBatch,
  type PaintUsage,
  type RecallNoticeDraft,
  type RecallOrder,
  type RecallPreview,
  type UsageProcess,
} from '@/types/paint';
import { buildRecallPreview, PaintServiceError, reconcileBatches, type BatchReconcileRow } from '@/utils/paintService';

/** 批次标签颜色（停用批次醒目） */
function BatchTag({ batchId, batches }: { batchId: string; batches: PaintBatch[] }) {
  if (batchId === UNTRACED_BATCH_ID) {
    return <Tag color="default">{UNTRACED_BATCH_LABEL}</Tag>;
  }
  const batch = batches.find((item) => item.id === batchId);
  if (!batch) return <Tag color="default">{batchId}</Tag>;
  return (
    <Tag color={batch.status === 'inactive' ? 'error' : 'gold'}>
      {batch.batchNo}
      {batch.status === 'inactive' ? ' · 停用' : ''}
    </Tag>
  );
}

export default function PaintBoard() {
  const { message } = AntdApp.useApp();
  const [batchForm] = Form.useForm();
  const [usageForm] = Form.useForm();
  const [noticeForm] = Form.useForm();

  const bodies = useBodyStore((state) => state.bodies);
  const coats = useCoatStore((state) => state.coats);
  const rooms = useRoomStore((state) => state.rooms);
  const inlayTable = useIdbTable((database) => database.inlays, { sortByUpdatedAt: false });
  const polishTable = useIdbTable((database) => database.polishes, { sortByUpdatedAt: false });
  const inspectTable = useIdbTable((database) => database.inspects, { sortByUpdatedAt: false });

  const batches = usePaintStore((state) => state.batches);
  const usages = usePaintStore((state) => state.usages);
  const recalls = usePaintStore((state) => state.recalls);
  const loadPaint = usePaintStore((state) => state.loadPaint);
  const createBatch = usePaintStore((state) => state.createBatch);
  const registerUsage = usePaintStore((state) => state.registerUsage);
  const registerNotice = usePaintStore((state) => state.registerNotice);
  const confirmRecall = usePaintStore((state) => state.confirmRecall);

  const [batchOpen, setBatchOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [preview, setPreview] = useState<RecallPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [reconRows, setReconRows] = useState<BatchReconcileRow[] | null>(null);

  useEffect(() => {
    void loadPaint();
  }, [loadPaint]);

  const bodyCode = (bodyId: string): string => bodies.find((body) => body.id === bodyId)?.code ?? bodyId;

  const frozenCount = useMemo(
    () => ({
      bodies: bodies.filter((row) => row.frozen).length,
      coats: coats.filter((row) => row.frozen).length,
      polishes: polishTable.rows.filter((row) => row.frozen).length,
      inlays: inlayTable.rows.filter((row) => row.frozen).length,
      inspects: inspectTable.rows.filter((row) => row.frozen).length,
    }),
    [bodies, coats, polishTable.rows, inlayTable.rows, inspectTable.rows],
  );
  const frozenTotal = Object.values(frozenCount).reduce((sum, n) => sum + n, 0);
  const untracedCount = useMemo(
    () => coats.filter((coat) => coat.batchId === UNTRACED_BATCH_ID).length +
      inlayTable.rows.filter((row) => row.batchId === UNTRACED_BATCH_ID).length,
    [coats, inlayTable.rows],
  );

  /* --------------------------- 批次台账 --------------------------- */

  const openBatchCreate = (): void => {
    batchForm.setFieldsValue(createEmptyPaintBatchDraft());
    setBatchOpen(true);
  };

  const submitBatch = async (): Promise<void> => {
    const values = await batchForm.validateFields();
    try {
      const batch = await createBatch({ ...values, batchNo: values.batchNo.trim() });
      message.success(`批次 ${batch.batchNo} 已入库 ${batch.receivedQty} ${PAINT_UNIT_LABEL[batch.unit]}`);
      setBatchOpen(false);
    } catch (error) {
      message.error(error instanceof PaintServiceError ? error.message : '批次登记失败');
    }
  };

  const runReconcile = async (): Promise<void> => {
    setReconciling(true);
    try {
      const rows = await reconcileBatches();
      setReconRows(rows);
      const bad = rows.filter((row) => !row.balanced).length;
      if (bad === 0) message.success(`对账完成：${rows.length} 个批次账实相符`);
      else message.warning(`对账完成：${bad} 个批次台账余量与领用合计不一致`);
    } finally {
      setReconciling(false);
    }
  };

  const batchColumns: ColumnsType<PaintBatch> = [
    { title: '批次号', dataIndex: 'batchNo', width: 150, render: (value: string, record) => (
      <Space size={4}>
        <Typography.Text strong>{value}</Typography.Text>
        {record.status === 'inactive' ? <FrozenTag frozen reason={record.note} size="small" /> : null}
      </Space>
    ) },
    { title: '漆种', dataIndex: 'kind', width: 90, render: (value: PaintBatch['kind']) => <Tag>{PAINT_KIND_LABEL[value]}</Tag> },
    { title: '色名', dataIndex: 'colorName', width: 130 },
    { title: '供应商', dataIndex: 'supplier', width: 140, render: (value: string) => value || '未填写' },
    { title: '生产日期', dataIndex: 'producedDate', width: 110 },
    {
      title: '入库量',
      dataIndex: 'receivedQty',
      width: 100,
      align: 'right',
      render: (value: number, record) => `${value} ${record.unit}`,
    },
    {
      title: '台账余量',
      dataIndex: 'remainingQty',
      width: 110,
      align: 'right',
      render: (value: number, record) => (
        <Typography.Text type={value <= 0 ? 'danger' : value < value * 0.1 ? 'warning' : undefined} strong>
          {value} {record.unit}
        </Typography.Text>
      ),
    },
    { title: '状态', dataIndex: 'status', width: 90, render: (value: PaintBatch['status']) => (
      <Badge status={value === 'active' ? 'success' : 'error'} text={PAINT_BATCH_STATUS_LABEL[value]} />
    ) },
    { title: '备注', dataIndex: 'note', render: (value: string) => (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{value || '—'}</Typography.Text>
    ) },
  ];

  const reconColumns: ColumnsType<BatchReconcileRow> = [
    { title: '批次号', dataIndex: ['batch', 'batchNo'], width: 150 },
    { title: '入库', dataIndex: ['batch', 'receivedQty'], width: 90, align: 'right', render: (_v, r) => `${r.batch.receivedQty} ${r.batch.unit}` },
    { title: '髹涂领用', dataIndex: 'coatUsed', width: 100, align: 'right', render: (v: number, r) => `${v} ${r.batch.unit}` },
    { title: '镶嵌领用', dataIndex: 'inlayUsed', width: 100, align: 'right', render: (v: number, r) => `${v} ${r.batch.unit}` },
    { title: '领用合计', dataIndex: 'usedTotal', width: 100, align: 'right', render: (v: number, r) => `${v} ${r.batch.unit}` },
    { title: '理论余量', dataIndex: 'expectedRemaining', width: 100, align: 'right', render: (v: number, r) => `${v} ${r.batch.unit}` },
    { title: '台账余量', dataIndex: ['batch', 'remainingQty'], width: 100, align: 'right', render: (_v, r) => `${r.batch.remainingQty} ${r.batch.unit}` },
    {
      title: '对账',
      key: 'balanced',
      render: (_v, row) =>
        row.balanced ? (
          <Tag color="success">账实相符</Tag>
        ) : (
          <Tooltip title="台账只记余量时容易与领用合计脱节，差额非 0 请核对历史登记">
            <Tag color="error">差额 {row.diff > 0 ? `+${row.diff}` : row.diff} {row.batch.unit}</Tag>
          </Tooltip>
        ),
    },
  ];

  /* --------------------------- 领用登记 --------------------------- */

  const watchedProcess = (Form.useWatch('process', usageForm) ?? 'coat') as UsageProcess;
  const watchedBatchId = Form.useWatch('batchId', usageForm) as string | undefined;
  const watchedBodyId = Form.useWatch('bodyId', usageForm) as string | undefined;

  const activeBatches = useMemo(() => batches.filter((batch) => batch.status === 'active'), [batches]);
  const watchedBatch = batches.find((batch) => batch.id === watchedBatchId) ?? null;

  const coatOptions = useMemo(() => {
    if (!watchedBodyId) return [];
    return coats
      .filter((coat) => coat.bodyId === watchedBodyId)
      .sort((a, b) => a.seq - b.seq)
      .map((coat) => ({
        value: coat.id,
        label: `第 ${coat.seq} 道 · ${PAINT_TYPE_LABEL[coat.paintType]} · ${coat.colorName}（${COAT_STATE_LABEL[coat.state]}）`,
      }));
  }, [coats, watchedBodyId]);

  const inlayOptions = useMemo(() => {
    if (!watchedBodyId) return [];
    return inlayTable.rows
      .filter((row) => row.bodyId === watchedBodyId)
      .map((row) => ({
        value: row.id,
        label: `${INLAY_TYPE_LABEL[row.type]} · ${row.pattern}（${row.position}）`,
      }));
  }, [inlayTable.rows, watchedBodyId]);

  const openUsageCreate = (): void => {
    if (activeBatches.length === 0) {
      message.warning('还没有在用漆料批次，请先在「批次台账」登记入库');
      return;
    }
    usageForm.resetFields();
    usageForm.setFieldsValue({
      process: 'coat',
      batchId: activeBatches[0]?.id,
      bodyId: bodies[0]?.id,
      qty: 50,
      usageDate: new Date().toISOString().slice(0, 10),
      operator: '',
      note: '',
    });
    setUsageOpen(true);
  };

  const submitUsage = async (): Promise<void> => {
    const values = await usageForm.validateFields();
    const draft = {
      batchId: values.batchId,
      process: values.process as UsageProcess,
      bodyId: values.bodyId,
      coatId: values.process === 'coat' ? (values.coatId ?? null) : null,
      inlayId: values.process === 'inlay' ? (values.inlayId ?? null) : null,
      qty: Number(values.qty),
      operator: values.operator ?? '',
      usageDate: values.usageDate,
      note: values.note ?? '',
    };
    try {
      const usage = await registerUsage(draft);
      message.success(`已登记领用 ${usage.qty} ${PAINT_UNIT_LABEL[usage.unit]}，台账余量同步扣减`);
      setUsageOpen(false);
    } catch (error) {
      // 扣减失败事务已整体回滚（流水与余量都不落库）
      message.error(error instanceof PaintServiceError ? error.message : '领用登记失败，已取消');
    }
  };

  const usageColumns: ColumnsType<PaintUsage> = [
    { title: '领用日期', dataIndex: 'usageDate', width: 110, sorter: (a, b) => a.usageDate.localeCompare(b.usageDate) },
    {
      title: '工序',
      dataIndex: 'process',
      width: 90,
      render: (value: UsageProcess) => <Tag color={value === 'coat' ? '#8c2f1f' : '#7d6ba8'}>{USAGE_PROCESS_LABEL[value]}</Tag>,
    },
    { title: '批次', dataIndex: 'batchNo', width: 150, render: (_value: string, record) => <BatchTag batchId={record.batchId} batches={batches} /> },
    { title: '胎体', dataIndex: 'bodyId', width: 110, render: (value: string) => <Tag color="#8c2f1f">{bodyCode(value)}</Tag> },
    {
      title: '关联记录',
      key: 'ref',
      render: (_v, record) => {
        if (record.process === 'coat') {
          const coat = coats.find((item) => item.id === record.coatId);
          return coat
            ? `第 ${coat.seq} 道 · ${coat.colorName}`
            : record.coatId
              ? '道次已删除'
              : '—';
        }
        const inlay = inlayTable.rows.find((item) => item.id === record.inlayId);
        return inlay ? `${INLAY_TYPE_LABEL[inlay.type]} · ${inlay.pattern}` : record.inlayId ? '镶嵌记录已删除' : '—';
      },
    },
    { title: '领用量', dataIndex: 'qty', width: 100, align: 'right', render: (value: number, record) => `${value} ${record.unit}` },
    { title: '领用人', dataIndex: 'operator', width: 100, render: (value: string) => value || '未填写' },
    { title: '备注', dataIndex: 'note', render: (value: string) => (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{value || '—'}</Typography.Text>
    ) },
  ];

  /* --------------------------- 停用通报与召回 --------------------------- */

  const openNotice = (): void => {
    if (batches.length === 0) {
      message.warning('还没有漆料批次可通报');
      return;
    }
    noticeForm.resetFields();
    noticeForm.setFieldsValue({
      batchId: batches.find((batch) => batch.status === 'active')?.id ?? batches[0]?.id,
      noticeNo: '',
      noticeDate: new Date().toISOString().slice(0, 10),
      reason: '',
    });
    setPreview(null);
    setNoticeOpen(true);
  };

  const refreshPreview = async (batchId?: string): Promise<void> => {
    const id = batchId ?? (noticeForm.getFieldValue('batchId') as string | undefined);
    if (!id) {
      setPreview(null);
      return;
    }
    setPreviewLoading(true);
    try {
      setPreview(await buildRecallPreview(id));
    } catch (error) {
      message.error(error instanceof PaintServiceError ? error.message : '预览失败');
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const submitNotice = async (): Promise<void> => {
    const values = await noticeForm.validateFields();
    const draft: RecallNoticeDraft = {
      noticeNo: String(values.noticeNo).trim(),
      batchId: values.batchId,
      noticeDate: values.noticeDate,
      reason: String(values.reason).trim(),
    };
    try {
      const order = await registerNotice(draft);
      message.success(`已登记通报 ${order.noticeNo} 并生成召回单，请在下方确认冻结`);
      setNoticeOpen(false);
    } catch (error) {
      message.error(error instanceof PaintServiceError ? error.message : '通报登记失败');
    }
  };

  const handleConfirmRecall = async (order: RecallOrder): Promise<void> => {
    try {
      const done = await confirmRecall(order.id);
      message.success(`召回单 ${done.noticeNo} 已冻结 ${Object.values(done.countSnapshot).reduce((s, n) => s + n, 0)} 条下游记录`);
    } catch (error) {
      message.error(
        `冻结失败已整单回滚，不留半套标记，可重试：${
          error instanceof PaintServiceError ? error.message : '未知错误'
        }`,
      );
    }
  };

  const previewBodyText = (bodyIds: string[]): string =>
    bodyIds.length === 0 ? '无' : bodyIds.map((id) => bodyCode(id)).join('、');

  const noticeModal = (
    <Modal
      open={noticeOpen}
      title="供应商通报：漆料批次停用"
      width={760}
      onCancel={() => setNoticeOpen(false)}
      okText="登记通报并生成召回单"
      cancelText="取消"
      onOk={() => void submitNotice()}
      destroyOnClose
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 14 }}
        message="先预览、后冻结"
        description="登记后批次立即停用（不可再领用），并生成唯一召回单；下游胎体 / 道次 / 打磨 / 镶嵌 / 质检需在召回单上确认后才冻结，冻结保留原值。"
      />
      <Form form={noticeForm} layout="vertical" preserve={false}>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="noticeNo" label="供应商通报编号" rules={[{ required: true, message: '同一通报只允许生成一份召回单' }]}>
              <Input placeholder="如：TB-2026-1018" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="noticeDate" label="通报日期" rules={[{ required: true }]}>
              <Input type="date" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item label="停用批次" required>
          <Space style={{ display: 'flex' }}>
            <Form.Item name="batchId" noStyle rules={[{ required: true, message: '请选择停用批次' }]}>
              <Select
                style={{ minWidth: 320 }}
                options={batches.map((batch) => ({
                  value: batch.id,
                  label: `${batch.batchNo} · ${PAINT_KIND_LABEL[batch.kind]} · ${batch.colorName}（${
                    PAINT_BATCH_STATUS_LABEL[batch.status]
                  }）`,
                }))}
                onChange={(value: string) => void refreshPreview(value)}
              />
            </Form.Item>
            <Button loading={previewLoading} icon={<ExperimentOutlined />} onClick={() => void refreshPreview()}>
              预览受影响记录
            </Button>
          </Space>
        </Form.Item>
        <Form.Item name="reason" label="停用原因" rules={[{ required: true, message: '请填写停用原因' }]}>
          <Input.TextArea rows={2} placeholder="如：重金属含量超标 / 掺杂改性漆，供应商主动召回" />
        </Form.Item>
      </Form>

      <Card size="small" title="受影响记录预览（确认后冻结）" loading={previewLoading}>
        {preview === null ? (
          <Typography.Text type="secondary">选择批次后点击「预览受影响记录」。</Typography.Text>
        ) : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Descriptions size="small" column={2}>
              <Descriptions.Item label="批次号">{preview.batchNo}</Descriptions.Item>
              <Descriptions.Item label="涉及胎体">
                <Typography.Text strong>{preview.bodyIds.length}</Typography.Text> 件（{previewBodyText(preview.bodyIds)}）
              </Descriptions.Item>
            </Descriptions>
            <Space size={8} wrap>
              {preview.sections.map((section) => (
                <Tag key={section.key} color={section.count > 0 ? 'volcano' : 'default'}>
                  {section.label} {section.count}
                </Tag>
              ))}
              <Tag color="magenta">合计 {preview.total} 条</Tag>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              追溯口径：道次与镶嵌直接引用批次；打磨按同胎体同对应道次追溯；质检按涉及胎体追溯。
            </Typography.Text>
          </Space>
        )}
      </Card>
    </Modal>
  );

  const recallColumns: ColumnsType<RecallOrder> = [
    { title: '通报编号', dataIndex: 'noticeNo', width: 140, render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
    { title: '批次号', dataIndex: 'batchNo', width: 150 },
    { title: '供应商', dataIndex: 'supplier', width: 130, render: (v: string) => v || '未填写' },
    { title: '通报日期', dataIndex: 'noticeDate', width: 110 },
    {
      title: '冻结范围',
      key: 'counts',
      render: (_v, record) => (
        <Space size={4} wrap>
          <Tag>胎体 {record.countSnapshot.bodies}</Tag>
          <Tag>道次 {record.countSnapshot.coats}</Tag>
          <Tag>打磨 {record.countSnapshot.polishes}</Tag>
          <Tag>镶嵌 {record.countSnapshot.inlays}</Tag>
          <Tag>质检 {record.countSnapshot.inspects}</Tag>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 120,
      render: (value: RecallOrder['status'], record) => (
        <Space direction="vertical" size={0}>
          <Badge
            status={value === 'done' ? 'success' : value === 'failed' ? 'error' : value === 'freezing' ? 'processing' : 'warning'}
            text={RECALL_STATUS_LABEL[value]}
          />
          {record.errorNote ? (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              {record.errorNote}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_v, record) =>
        record.status === 'done' ? (
          <Typography.Text type="secondary">已完成冻结</Typography.Text>
        ) : (
          <Popconfirm
            title={`确认冻结召回单 ${record.noticeNo}？`}
            description={`将冻结胎体/道次/打磨/镶嵌/质检共 ${Object.values(record.countSnapshot).reduce((s, n) => s + n, 0)} 条记录，原值保留，失败自动整单回滚。`}
            okText="确认冻结"
            cancelText="取消"
            onConfirm={() => void handleConfirmRecall(record)}
          >
            <Button type="primary" size="small" danger icon={<SafetyCertificateOutlined />}>
              {record.status === 'failed' ? '重试冻结' : '确认冻结'}
            </Button>
          </Popconfirm>
        ),
    },
  ];

  const statRow = (
    <div className="gb-stat-row">
      <StatBadge label="在用批次" value={batches.filter((b) => b.status === 'active').length} suffix="个" tone="primary" />
      <StatBadge label="停用批次" value={batches.filter((b) => b.status === 'inactive').length} suffix="个" tone="warning" />
      <StatBadge label="领用流水" value={usages.length} suffix="条" tone="info" />
      <StatBadge label="召回单" value={recalls.length} suffix="份" tone="danger" />
      <StatBadge label="冻结记录" value={frozenTotal} suffix="条" tone="danger" />
      <StatBadge label="未追溯" value={untracedCount} suffix="条" tone="default" />
    </div>
  );

  const batchTab = (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" icon={<PlusOutlined />} onClick={openBatchCreate}>
          登记批次入库
        </Button>
        <Button icon={<AuditOutlined />} loading={reconciling} onClick={() => void runReconcile()}>
          {reconRows === null ? '与漆料台账对账' : '重新对账'}
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          台账只记余量时，对账按「入库量 − 髹涂领用 − 镶嵌领用 = 理论余量」核对，差额非 0 即异常。
        </Typography.Text>
      </Space>

      {reconRows !== null ? (
        <Card
          size="small"
          style={{ marginBottom: 14 }}
          title={<Space><AuditOutlined /> 对账结果</Space>}
          extra={
            <Button size="small" type="link" onClick={() => setReconRows(null)}>
              收起
            </Button>
          }
        >
          <Table<BatchReconcileRow>
            rowKey={(row) => row.batch.id}
            size="small"
            pagination={false}
            columns={reconColumns}
            dataSource={reconRows}
          />
        </Card>
      ) : null}

      <Card className="gb-table-card" styles={{ body: { padding: 0 } }}>
        {batches.length === 0 ? (
          <EmptyPanel
            title="还没有漆料批次"
            description="先登记供应商漆料批次入库（漆种、批次号、入库量），髹涂与镶嵌工序才能登记领用。"
            actionText="登记批次入库"
            onAction={openBatchCreate}
            size="small"
          />
        ) : (
          <Table<PaintBatch> rowKey="id" size="small" pagination={false} columns={batchColumns} dataSource={batches} />
        )}
      </Card>

      <Modal
        open={batchOpen}
        title="登记漆料批次入库"
        onCancel={() => setBatchOpen(false)}
        onOk={() => void submitBatch()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={batchForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="batchNo" label="批次号" rules={[{ required: true, message: '请填写批次号' }]}>
                <Input placeholder="如：SQ-2601-RAW" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="producedDate" label="生产日期" rules={[{ required: true }]}>
                <Input type="date" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="kind" label="漆种" rules={[{ required: true }]}>
                <Select options={[...PAINT_KIND_OPTIONS]} />
              </Form.Item>
            </Col>
            <Col span={9}>
              <Form.Item name="colorName" label="色名" rules={[{ required: true, message: '请填写色名' }]}>
                <Input placeholder="如：漆黑" />
              </Form.Item>
            </Col>
            <Col span={7}>
              <Form.Item name="unit" label="计量单位" rules={[{ required: true }]}>
                <Select options={[...PAINT_UNIT_OPTIONS]} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="supplier" label="供应商">
                <Input placeholder="如：秦巴天然漆社" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="receivedQty" label="入库量" rules={[{ required: true, message: '入库量需大于 0' }]}>
                <InputNumber min={1} max={100000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );

  const usageTab = (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" icon={<PlusOutlined />} onClick={openUsageCreate}>
          登记领用
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          髹涂、镶嵌两个工序领用同一批次都在此登记；保存即扣减台账余量，余量不足时整笔回滚。
        </Typography.Text>
      </Space>
      <Card className="gb-table-card" styles={{ body: { padding: 0 } }}>
        {usages.length === 0 ? (
          <EmptyPanel
            title="还没有领用记录"
            description="选择批次、工序与关联的道次 / 镶嵌记录，登记领用量并自动扣减台账余量。"
            actionText="登记领用"
            onAction={openUsageCreate}
            size="small"
          />
        ) : (
          <Table<PaintUsage>
            rowKey="id"
            size="small"
            pagination={{ pageSize: 10 }}
            columns={usageColumns}
            dataSource={usages}
          />
        )}
      </Card>

      <Modal
        open={usageOpen}
        title="登记漆料领用"
        onCancel={() => setUsageOpen(false)}
        onOk={() => void submitUsage()}
        okText="保存并扣减"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={usageForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="process" label="领用工序" rules={[{ required: true }]}>
                <Select options={[...USAGE_PROCESS_OPTIONS]} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="usageDate" label="领用日期" rules={[{ required: true }]}>
                <Input type="date" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="batchId" label="漆料批次（仅在用批次可选）" rules={[{ required: true, message: '请选择漆料批次' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={activeBatches.map((batch) => ({
                value: batch.id,
                label: `${batch.batchNo} · ${PAINT_KIND_LABEL[batch.kind]} · ${batch.colorName}（可用 ${batch.remainingQty} ${batch.unit}）`,
              }))}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="bodyId" label="关联胎体" rules={[{ required: true, message: '请选择胎体' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  options={bodies.map((body) => ({
                    value: body.id,
                    label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}`,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="qty"
                label={`领用量${watchedBatch ? `（可用 ${watchedBatch.remainingQty} ${watchedBatch.unit}）` : ''}`}
                rules={[{ required: true, message: '领用量需大于 0' }]}
              >
                <InputNumber min={1} max={100000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          {watchedProcess === 'coat' ? (
            <Form.Item name="coatId" label="关联髹涂道次" rules={[{ required: true, message: '髹涂工序必须关联道次' }]}>
              <Select options={coatOptions} placeholder="先选择胎体" />
            </Form.Item>
          ) : (
            <Form.Item name="inlayId" label="关联镶嵌记录" rules={[{ required: true, message: '镶嵌工序必须关联镶嵌记录' }]}>
              <Select options={inlayOptions} placeholder="先选择胎体" />
            </Form.Item>
          )}
          <Form.Item name="operator" label="领用人">
            <Input placeholder="如：陈漆匠" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );

  const recallTab = (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button danger type="primary" icon={<WarningOutlined />} onClick={openNotice}>
          登记停用通报
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          同一供应商通报只生成一份召回单；确认后冻结的记录保留原值、禁止编辑，冻结失败自动整单回滚并可重试。
        </Typography.Text>
      </Space>

      <Row gutter={16} style={{ marginBottom: 14 }}>
        <Col xs={24} lg={16}>
          <Card className="gb-table-card" styles={{ body: { padding: 0 } }}>
            {recalls.length === 0 ? (
              <EmptyPanel
                title="还没有停用通报 / 召回单"
                description="收到供应商批次停用通报后，先预览受影响的胎体、道次、打磨、镶嵌与质检，再确认冻结。"
                actionText="登记停用通报"
                onAction={openNotice}
                size="small"
              />
            ) : (
              <Table<RecallOrder>
                rowKey="id"
                size="small"
                pagination={false}
                columns={recallColumns}
                dataSource={recalls}
                expandable={{
                  expandedRowRender: (record) => (
                    <Space direction="vertical" size={4}>
                      <Typography.Text type="secondary">停用原因：{record.reason}</Typography.Text>
                      <Typography.Text type="secondary">
                        涉及胎体：{previewBodyText(record.targets.bodyIds)}
                      </Typography.Text>
                      {record.frozenAt ? (
                        <Typography.Text type="secondary">冻结时间：{new Date(record.frozenAt).toLocaleString('zh-CN')}</Typography.Text>
                      ) : null}
                    </Space>
                  ),
                }}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small" title={<Space><CloudServerOutlined /> 下游冻结总览</Space>}>
            <Timeline
              items={[
                { color: 'gray', children: `胎体冻结 ${frozenCount.bodies} 件` },
                { color: 'gray', children: `髹涂道次冻结 ${frozenCount.coats} 道` },
                { color: 'gray', children: `打磨记录冻结 ${frozenCount.polishes} 条（荫房记录不冻结）` },
                { color: 'gray', children: `镶嵌记录冻结 ${frozenCount.inlays} 条` },
                { color: 'gray', children: `质检记录冻结 ${frozenCount.inspects} 条` },
              ]}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              应用重启后会自动继续处理「冻结中 / 冻结失败」的召回单。当前另有荫房记录 {rooms.length} 条（不纳入冻结）。
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      {noticeModal}
    </div>
  );

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>漆料批次台账与领用对账</h2>
          <p>
            髹涂与镶嵌工序共用漆料批次：登记领用、自动扣减余量并对账；供应商通报批次停用时预览影响范围，确认后召回冻结。
          </p>
        </div>
      </div>

      {statRow}

      <Tabs
        defaultActiveKey="batches"
        items={[
          { key: 'batches', label: '批次台账与对账', children: batchTab },
          { key: 'usages', label: `领用流水（${usages.length}）`, children: usageTab },
          { key: 'recalls', label: `停用召回（${recalls.length}）`, children: recallTab },
        ]}
      />
    </div>
  );
}
