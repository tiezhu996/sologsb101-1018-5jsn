/**
 * /paint 漆料批次台账与领用对账
 * 登记漆料批次（台账记余量）、髹涂与镶嵌工序领用；与漆料台账对账。
 * 同一批次两个标签页同时领用，原子事务保证用量不超过可用量，扣减失败一次回滚。
 * 消费 PaintBatch、PaintIssue、Body；复用 <StatBadge>、<EmptyPanel>、<TraceTag>。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  DatePicker,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  RollbackOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import StatBadge from '@/components/common/StatBadge';
import { usePaintStore } from '@/stores/paintStore';
import { useBodyStore } from '@/stores/bodyStore';
import { BODY_SHAPE_LABEL } from '@/types/body';
import { PAINT_TYPE_LABEL } from '@/types/coat';
import {
  PAINT_BATCH_STATUS_COLOR,
  PAINT_BATCH_STATUS_LABEL,
  PAINT_STAGE_COLOR,
  PAINT_STAGE_LABEL,
  PAINT_STAGE_OPTIONS,
  PaintBatchInactiveError,
  PaintShortageError,
  createEmptyPaintBatchDraft,
  createEmptyPaintIssueDraft,
  type PaintBatch,
  type PaintBatchDraft,
  type PaintIssue,
  type PaintIssueDraft,
  type PaintStage,
} from '@/types/paint';
import { reconcileAll, realignRemaining, type BatchReconcile } from '@/utils/paintLedger';

export default function PaintLedger() {
  const { message } = AntdApp.useApp();
  const [batchForm] = Form.useForm<PaintBatchDraft>();
  const [issueForm] = Form.useForm<PaintIssueDraft>();

  const batches = usePaintStore((state) => state.batches);
  const issues = usePaintStore((state) => state.issues);
  const createBatch = usePaintStore((state) => state.createBatch);
  const updateBatch = usePaintStore((state) => state.updateBatch);
  const removeBatch = usePaintStore((state) => state.removeBatch);
  const issuePaint = usePaintStore((state) => state.issuePaint);
  const reverseIssue = usePaintStore((state) => state.reverseIssue);

  const bodies = useBodyStore((state) => state.bodies);

  const [batchOpen, setBatchOpen] = useState(false);
  const [editingBatch, setEditingBatch] = useState<PaintBatch | null>(null);
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueBatchId, setIssueBatchId] = useState<string>('');
  const [reconcile, setReconcile] = useState<BatchReconcile[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const batchMap = useMemo(() => new Map(batches.map((batch) => [batch.id, batch])), [batches]);
  const bodyMap = useMemo(() => new Map(bodies.map((body) => [body.id, body])), [bodies]);

  const totals = useMemo(() => {
    const issued = issues.reduce((sum, row) => sum + row.qtyG, 0);
    const remaining = batches.reduce((sum, row) => sum + row.remainingQtyG, 0);
    return {
      batches: batches.length,
      active: batches.filter((batch) => batch.status === 'active').length,
      issues: issues.length,
      issued: Math.round(issued * 10) / 10,
      remaining: Math.round(remaining * 10) / 10,
    };
  }, [batches, issues]);

  const openCreateBatch = (): void => {
    setEditingBatch(null);
    batchForm.setFieldsValue(createEmptyPaintBatchDraft());
    setBatchOpen(true);
  };

  const openEditBatch = (batch: PaintBatch): void => {
    setEditingBatch(batch);
    batchForm.setFieldsValue({
      batchNo: batch.batchNo,
      paintType: batch.paintType,
      colorName: batch.colorName,
      supplier: batch.supplier,
      receivedDate: batch.receivedDate,
      initialQtyG: batch.initialQtyG,
    });
    setBatchOpen(true);
  };

  const submitBatch = async (): Promise<void> => {
    const values = await batchForm.validateFields();
    if (editingBatch) {
      // 初始量仅在无领用流水时可改；其余元数据可改
      const patch: Partial<PaintBatch> = {
        batchNo: values.batchNo.trim(),
        paintType: values.paintType,
        colorName: values.colorName,
        supplier: values.supplier,
        receivedDate: values.receivedDate,
      };
      const used = issues.filter((issue) => issue.batchId === editingBatch.id).length;
      if (used === 0) patch.initialQtyG = values.initialQtyG;
      await updateBatch(editingBatch.id, patch);
      message.success('已更新漆料批次');
    } else {
      await createBatch(values);
      message.success(`已登记批次 ${values.batchNo}`);
    }
    setBatchOpen(false);
  };

  const openIssue = (batchId = ''): void => {
    const first = batchId || batches.find((batch) => batch.status === 'active')?.id || '';
    setIssueBatchId(first);
    issueForm.setFieldsValue({
      ...createEmptyPaintIssueDraft(first),
      bodyId: null,
      coatSeq: null,
    });
    setIssueOpen(true);
  };

  const watchedStage = Form.useWatch('stage', issueForm) as PaintStage | undefined;

  const submitIssue = async (): Promise<void> => {
    const values = await issueForm.validateFields();
    setSubmitting(true);
    try {
      // 原子事务：超量 / 停用批次在此抛出，领用与扣减一次回滚
      await issuePaint({ ...values, batchId: issueBatchId });
      message.success(`已登记领用 ${values.qtyG}g 并扣减台账余量`);
      setIssueOpen(false);
    } catch (error) {
      if (error instanceof PaintShortageError) {
        message.error(error.message);
      } else if (error instanceof PaintBatchInactiveError) {
        message.error(error.message);
      } else {
        message.error(error instanceof Error ? error.message : '领用失败，已回滚');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const runReconcile = async (): Promise<void> => {
    const result = await reconcileAll();
    setReconcile(result);
    const bad = result.filter((item) => !item.consistent).length;
    if (bad === 0) message.success('对账完成：批次台账余量与领用流水全部一致');
    else message.warning(`对账发现 ${bad} 个批次台账与流水不一致`);
  };

  const batchColumns: ColumnsType<PaintBatch> = [
    { title: '批次号', dataIndex: 'batchNo', width: 110, render: (value: string) => <Tag color="#8c2f1f">{value}</Tag> },
    { title: '漆种', dataIndex: 'paintType', width: 90, render: (value: PaintBatch['paintType']) => PAINT_TYPE_LABEL[value] },
    { title: '色名', dataIndex: 'colorName', width: 90 },
    { title: '供应商', dataIndex: 'supplier', render: (value: string) => value || '未填写' },
    { title: '到货日期', dataIndex: 'receivedDate', width: 110 },
    { title: '入库量(g)', dataIndex: 'initialQtyG', width: 100, align: 'right' },
    {
      title: '台账余量(g)',
      dataIndex: 'remainingQtyG',
      width: 120,
      align: 'right',
      render: (value: number, record) => (
        <Tooltip title={`已领用 ${Math.round((record.initialQtyG - value) * 10) / 10}g`}>
          <Typography.Text strong type={value <= 0 ? 'danger' : undefined}>
            {value}
          </Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (value: PaintBatch['status']) => (
        <Tag color={PAINT_BATCH_STATUS_COLOR[value]}>{PAINT_BATCH_STATUS_LABEL[value]}</Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 230,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button
            size="small"
            type="link"
            disabled={record.status === 'inactive'}
            onClick={() => openIssue(record.id)}
          >
            登记领用
          </Button>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEditBatch(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该漆料批次"
            description="有领用流水的批次不可删除。"
            okText="确认"
            cancelText="取消"
            onConfirm={() =>
              void removeBatch(record.id)
                .then(() => message.success('已删除批次'))
                .catch((error: unknown) => message.error(error instanceof Error ? error.message : '删除失败'))
            }
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const issueColumns: ColumnsType<PaintIssue> = [
    { title: '领用日期', dataIndex: 'issueDate', width: 110 },
    {
      title: '工序',
      dataIndex: 'stage',
      width: 90,
      render: (value: PaintStage) => <Tag color={PAINT_STAGE_COLOR[value]}>{PAINT_STAGE_LABEL[value]}</Tag>,
    },
    {
      title: '批次',
      dataIndex: 'batchId',
      width: 100,
      render: (value: string) => batchMap.get(value)?.batchNo ?? value,
    },
    { title: '数量(g)', dataIndex: 'qtyG', width: 90, align: 'right' },
    { title: '领用人', dataIndex: 'receiver', width: 90, render: (value: string) => value || '未填写' },
    {
      title: '关联胎体',
      dataIndex: 'bodyId',
      width: 130,
      render: (value: string | null, record) =>
        value ? (bodyMap.get(value)?.code ?? value) + (record.coatSeq ? ` · 第${record.coatSeq}道` : '') : '—',
    },
    { title: '备注', dataIndex: 'note', render: (value: string) => value || '—' },
    {
      title: '操作',
      key: 'action',
      width: 90,
      render: (_value, record) => (
        <Popconfirm
          title="红冲该笔领用"
          description="将删除领用流水并把数量退回批次余量。"
          okText="确认红冲"
          cancelText="取消"
          onConfirm={() => void reverseIssue(record.id).then(() => message.success('已红冲并退回余量'))}
        >
          <Button size="small" type="link" icon={<RollbackOutlined />}>
            红冲
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>漆料批次台账与领用对账</h2>
          <p>同一批漆料领到髹涂与镶嵌工序，逐笔登记领用并扣减台账余量；可随时与领用流水对账校准。</p>
        </div>
        <Space wrap>
          <Button icon={<SafetyCertificateOutlined />} onClick={() => void runReconcile()}>
            与台账对账
          </Button>
          <Button icon={<PlusOutlined />} onClick={openCreateBatch}>
            登记漆料批次
          </Button>
          <Button type="primary" onClick={() => openIssue()}>
            登记领用
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="漆料批次" value={totals.batches} suffix="个" tone="primary" />
        <StatBadge label="在用批次" value={totals.active} suffix="个" tone="success" />
        <StatBadge label="领用流水" value={totals.issues} suffix="笔" tone="info" />
        <StatBadge label="累计领用" value={totals.issued} suffix="g" tone="warning" />
        <StatBadge label="台账总余量" value={totals.remaining} suffix="g" tone="danger" />
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message="多标签页并发安全"
        description="同一批次在两个标签页同时保存领用，扣减在单个数据库事务内串行执行：第二个操作会读到最新余量，超出可用量即报「余量不足」，领用流水与余量扣减整体回滚，不会出现超发。"
      />

      {reconcile ? (
        <Card
          size="small"
          style={{ marginBottom: 14 }}
          title="对账结果（台账余量 vs 初始量 − 领用汇总）"
          extra={<Button size="small" onClick={() => setReconcile(null)}>关闭</Button>}
        >
          <Table<BatchReconcile>
            rowKey={(row) => row.batch.id}
            size="small"
            pagination={false}
            dataSource={reconcile}
            columns={[
              { title: '批次号', dataIndex: ['batch', 'batchNo'], width: 110 },
              { title: '入库量(g)', dataIndex: 'initialQtyG', width: 100, align: 'right' },
              { title: '领用汇总(g)', dataIndex: 'issuedQtyG', width: 110, align: 'right' },
              { title: '台账余量(g)', dataIndex: 'ledgerRemainingG', width: 110, align: 'right' },
              { title: '推算余量(g)', dataIndex: 'computedRemainingG', width: 110, align: 'right' },
              {
                title: '差异(g)',
                dataIndex: 'diffG',
                width: 90,
                align: 'right',
                render: (value: number) => (
                  <Typography.Text type={Math.abs(value) > 0.1 ? 'danger' : 'success'}>{value}</Typography.Text>
                ),
              },
              {
                title: '结果',
                dataIndex: 'consistent',
                render: (value: boolean, record) =>
                  value ? (
                    <Tag color="success">一致</Tag>
                  ) : (
                    <Button
                      size="small"
                      type="link"
                      onClick={() =>
                        void realignRemaining(record.batch.id).then(async (val) => {
                          message.success(`已按流水校准 ${record.batch.batchNo} 余量为 ${val}g`);
                          await runReconcile();
                        })
                      }
                    >
                      按流水校准
                    </Button>
                  ),
              },
            ]}
          />
        </Card>
      ) : null}

      <Row gutter={16}>
        <Col xs={24} xl={14}>
          <Card className="gb-table-card" title="漆料批次台账" styles={{ body: { padding: 0 } }}>
            {batches.length === 0 ? (
              <EmptyPanel
                title="还没有漆料批次"
                description="先登记供应商批次与入库量，台账余量初始等于入库量。"
                actionText="登记漆料批次"
                onAction={openCreateBatch}
                size="small"
              />
            ) : (
              <Table<PaintBatch> rowKey="id" size="small" pagination={{ pageSize: 6 }} columns={batchColumns} dataSource={batches} />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card className="gb-table-card" title="领用流水（髹涂 / 镶嵌）" styles={{ body: { padding: 0 } }}>
            {issues.length === 0 ? (
              <EmptyPanel title="还没有领用记录" description="登记领用后会逐笔出现在这里。" size="small" />
            ) : (
              <Table<PaintIssue> rowKey="id" size="small" pagination={{ pageSize: 6 }} columns={issueColumns} dataSource={issues} />
            )}
          </Card>
        </Col>
      </Row>

      {/* 漆料批次表单 */}
      <Modal
        open={batchOpen}
        title={editingBatch ? `编辑批次 ${editingBatch.batchNo}` : '登记漆料批次'}
        onCancel={() => setBatchOpen(false)}
        onOk={() => void submitBatch()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={batchForm} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="batchNo" label="批次号" rules={[{ required: true, message: '请填写批次号' }]} style={{ flex: 1 }}>
              <Input placeholder="如：R-2401" />
            </Form.Item>
            <Form.Item name="paintType" label="漆种" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select
                options={[
                  { value: 'raw', label: '生漆' },
                  { value: 'color', label: '色漆' },
                  { value: 'topcoat', label: '罩漆' },
                ]}
              />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="colorName" label="色名" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input placeholder="如：漆黑" />
            </Form.Item>
            <Form.Item name="supplier" label="供应商" style={{ flex: 1 }}>
              <Input placeholder="如：巴山漆坊" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="receivedDate" label="到货日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
            <Form.Item
              name="initialQtyG"
              label="入库量（g）"
              rules={[{ required: true }]}
              style={{ flex: 1 }}
              tooltip={editingBatch ? '已有领用流水后入库量锁定' : undefined}
            >
              <InputNumber min={1} style={{ width: '100%' }} disabled={!!editingBatch} />
            </Form.Item>
          </Space>
          {editingBatch ? (
            <Alert type="info" showIcon message={`台账余量 ${editingBatch.remainingQtyG}g 由领用流水自动维护，不可手改`} />
          ) : null}
        </Form>
      </Modal>

      {/* 领用登记表单 */}
      <Modal
        open={issueOpen}
        title="登记漆料领用（原子扣减）"
        onCancel={() => setIssueOpen(false)}
        onOk={() => void submitIssue()}
        okText="保存并扣减"
        cancelText="取消"
        confirmLoading={submitting}
        destroyOnClose
      >
        <Form form={issueForm} layout="vertical" preserve={false}>
          <Form.Item name="batchId" label="漆料批次" rules={[{ required: true, message: '请选择批次' }]}>
            <Select
              placeholder="选择在用批次"
              value={issueBatchId || undefined}
              onChange={(value: string) => setIssueBatchId(value)}
              options={batches.map((batch) => ({
                value: batch.id,
                label: `${batch.batchNo} · ${PAINT_TYPE_LABEL[batch.paintType]}${batch.colorName} · 余 ${batch.remainingQtyG}g${
                  batch.status === 'inactive' ? '（已停用）' : ''
                }`,
                disabled: batch.status === 'inactive',
              }))}
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="stage" label="领用工序" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...PAINT_STAGE_OPTIONS]} />
            </Form.Item>
            <Form.Item name="qtyG" label="领用数量（g）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={1} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="issueDate"
              label="领用日期"
              rules={[{ required: true }]}
              style={{ flex: 1 }}
              getValueProps={(value: string) => ({ value: value ? dayjs(value) : null })}
              getValueFromEvent={(value: dayjs.Dayjs | null) => (value ? value.format('YYYY-MM-DD') : '')}
            >
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="receiver" label="领用人" style={{ flex: 1 }}>
              <Input placeholder="如：王丽" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="bodyId" label="关联胎体" style={{ flex: 1 }}>
              <Select
                allowClear
                placeholder="可选"
                options={bodies.map((body) => ({ value: body.id, label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}` }))}
              />
            </Form.Item>
            {watchedStage === 'coat' ? (
              <Form.Item name="coatSeq" label="关联道次" style={{ flex: 1 }}>
                <InputNumber min={1} max={99} style={{ width: '100%' }} placeholder="如：1" />
              </Form.Item>
            ) : null}
          </Space>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="如：头道生漆打底" />
          </Form.Item>
          {issueBatchId ? (
            <Alert
              type="warning"
              showIcon
              message={`该批次当前可用 ${batchMap.get(issueBatchId)?.remainingQtyG ?? 0}g，超出将保存失败并整体回滚`}
            />
          ) : null}
        </Form>
      </Modal>
    </div>
  );
}
