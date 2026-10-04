/**
 * /recall 漆料批次停用召回
 * 供应商通报批次停用：先预览受影响的胎体、道次、打磨、镶嵌与质检，
 * 确认后冻结下游记录并保留原值；同一通报只生成一份召回单，重启后可继续处理。
 * 消费 PaintBatch、PaintRecall 及五类下游模型；复用 <StatBadge>、<FrozenBadge>、<TraceTag>。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { NotificationOutlined, PlayCircleOutlined } from '@ant-design/icons';
import StatBadge from '@/components/common/StatBadge';
import FrozenBadge from '@/components/common/FrozenBadge';
import { usePaintStore } from '@/stores/paintStore';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { BODY_SHAPE_LABEL, BODY_STATE_LABEL } from '@/types/body';
import { COAT_STATE_LABEL, PAINT_TYPE_LABEL } from '@/types/coat';
import { POLISH_METHOD_LABEL } from '@/types/polish';
import { INLAY_TYPE_LABEL } from '@/types/inlay';
import { INSPECT_VERDICT_LABEL } from '@/types/inspect';
import { PAINT_BATCH_STATUS_LABEL } from '@/types/paint';
import { RECALL_STATUS_COLOR, RECALL_STATUS_LABEL, type PaintRecall, type RecallPreview } from '@/types/recall';
import { buildRecallPreview, createAndFreezeRecall, resumePendingRecalls } from '@/utils/recall';
import { UNTRACED_LABEL } from '@/types/paint';
import type { Polish } from '@/types/polish';
import type { Inlay } from '@/types/inlay';
import type { Inspect } from '@/types/inspect';

interface NoticeForm {
  batchId: string;
  noticeNo: string;
  source: string;
  noticeDate: string;
}

export default function RecallBoard() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<NoticeForm>();

  const batches = usePaintStore((state) => state.batches);
  const recalls = usePaintStore((state) => state.recalls);
  const loadPaint = usePaintStore((state) => state.loadPaint);
  const bodies = useBodyStore((state) => state.bodies);
  const loadBodies = useBodyStore((state) => state.loadBodies);
  const loadCoats = useCoatStore((state) => state.loadCoats);

  const [preview, setPreview] = useState<RecallPreview | null>(null);
  const [previewBatchId, setPreviewBatchId] = useState<string>('');
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const bodyMap = useMemo(() => new Map(bodies.map((body) => [body.id, body])), [bodies]);
  const bodyCode = (bodyId: string): string => bodyMap.get(bodyId)?.code ?? bodyId;

  const pendingCount = recalls.filter((recall) => recall.status === 'pending').length;
  const frozenCount = recalls.length - pendingCount;

  const loadAll = async (): Promise<void> => {
    await Promise.all([loadPaint(), loadBodies(), loadCoats()]);
  };

  const runPreview = async (batchId: string): Promise<void> => {
    if (!batchId) {
      message.warning('请先选择漆料批次');
      return;
    }
    const result = await buildRecallPreview(batchId);
    if (!result) {
      message.error('未找到该批次');
      return;
    }
    setPreview(result);
    setPreviewBatchId(batchId);
  };

  const openNotice = (): void => {
    if (!preview) return;
    form.setFieldsValue({
      batchId: preview.batchId,
      noticeNo: '',
      source: '',
      noticeDate: new Date().toISOString().slice(0, 10),
    });
    setNoticeOpen(true);
  };

  const confirmFreeze = async (): Promise<void> => {
    const values = await form.validateFields();
    setBusy(true);
    try {
      // 单事务：建召回单 + 五类下游整体冻结，失败回滚不留半套标记
      const { reused } = await createAndFreezeRecall({
        noticeNo: values.noticeNo,
        batchId: values.batchId,
        source: values.source,
        noticeDate: values.noticeDate,
      });
      await loadAll();
      message.success(reused ? '该通报已存在召回单，已复用，不重复生成' : '召回单已生成，下游记录已整体冻结');
      setNoticeOpen(false);
      setPreview(null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '冻结失败，已整体回滚');
    } finally {
      setBusy(false);
    }
  };

  const handleResume = async (): Promise<void> => {
    setBusy(true);
    try {
      const { resumed, failed } = await resumePendingRecalls();
      await loadAll();
      if (resumed === 0 && failed.length === 0) message.info('没有待续处理的召回单');
      else if (failed.length === 0) message.success(`已继续处理并完成 ${resumed} 份召回单`);
      else message.warning(`完成 ${resumed} 份，${failed.length} 份仍失败（保留 pending，可再次重试）`);
    } finally {
      setBusy(false);
    }
  };

  const coatColumns: ColumnsType<RecallPreview['coats'][number]> = [
    { title: '胎体', dataIndex: 'bodyId', width: 100, render: (value: string) => bodyCode(value) },
    { title: '道次', dataIndex: 'seq', width: 70, render: (seq: number) => `第 ${seq} 道` },
    { title: '漆种', dataIndex: 'paintType', width: 90, render: (value: RecallPreview['coats'][number]['paintType']) => PAINT_TYPE_LABEL[value] },
    { title: '色名', dataIndex: 'colorName', width: 90 },
    {
      title: '当前状态（原值保留）',
      dataIndex: 'state',
      render: (value: RecallPreview['coats'][number]['state'], record) => (
        <Space size={4}>
          <Tag>{COAT_STATE_LABEL[value]}</Tag>
          <FrozenBadge record={record} originalText={COAT_STATE_LABEL[record.state]} />
        </Space>
      ),
    },
  ];

  const bodyColumns: ColumnsType<RecallPreview['bodies'][number]> = [
    { title: '编号', dataIndex: 'code', width: 110 },
    { title: '器型', dataIndex: 'shape', width: 80, render: (value: RecallPreview['bodies'][number]['shape']) => BODY_SHAPE_LABEL[value] },
    { title: '委托/藏家', dataIndex: 'ownerName' },
    {
      title: '当前状态（原值保留）',
      dataIndex: 'state',
      render: (value: RecallPreview['bodies'][number]['state'], record) => (
        <Space size={4}>
          <Tag>{BODY_STATE_LABEL[value]}</Tag>
          <FrozenBadge record={record} originalText={BODY_STATE_LABEL[record.state]} />
        </Space>
      ),
    },
  ];

  const polishColumns: ColumnsType<Polish> = [
    { title: '胎体', dataIndex: 'bodyId', width: 100, render: (value: string) => bodyCode(value) },
    { title: '道次', dataIndex: 'seq', width: 80, render: (seq: number) => `第 ${seq} 道` },
    { title: '目数', dataIndex: 'grit', width: 90 },
    { title: '手法', dataIndex: 'method', render: (value: Polish['method']) => POLISH_METHOD_LABEL[value] },
    { title: '操作人', dataIndex: 'operator', render: (value: string) => value || '未填写' },
    { title: '', key: 'frozen', render: (_v, record) => <FrozenBadge record={record} /> },
  ];

  const inlayColumns: ColumnsType<Inlay> = [
    { title: '胎体', dataIndex: 'bodyId', width: 100, render: (value: string) => bodyCode(value) },
    { title: '类型', dataIndex: 'type', width: 90, render: (value: Inlay['type']) => INLAY_TYPE_LABEL[value] },
    { title: '图案', dataIndex: 'pattern' },
    { title: '位置', dataIndex: 'position' },
    { title: '', key: 'frozen', render: (_v, record) => <FrozenBadge record={record} /> },
  ];

  const inspectColumns: ColumnsType<Inspect> = [
    { title: '胎体', dataIndex: 'bodyId', width: 100, render: (value: string) => bodyCode(value) },
    { title: '日期', dataIndex: 'date', width: 110 },
    { title: '结论', dataIndex: 'verdict', render: (value: Inspect['verdict']) => INSPECT_VERDICT_LABEL[value] },
    { title: '质检人', dataIndex: 'inspector', render: (value: string) => value || '未填写' },
    { title: '', key: 'frozen', render: (_v, record) => <FrozenBadge record={record} /> },
  ];

  const recallColumns: ColumnsType<PaintRecall> = [
    { title: '通报号', dataIndex: 'noticeNo', width: 120, render: (value: string) => <Tag color="#8c2f1f">{value}</Tag> },
    { title: '批次号', dataIndex: 'batchNo', width: 100 },
    { title: '通报日期', dataIndex: 'noticeDate', width: 110 },
    { title: '来源', dataIndex: 'source', render: (value: string) => value || '—' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: PaintRecall['status']) => (
        <Tag color={RECALL_STATUS_COLOR[value]}>{RECALL_STATUS_LABEL[value]}</Tag>
      ),
    },
    {
      title: '冻结数量（胎/道/磨/嵌/检）',
      key: 'counts',
      render: (_v, record) =>
        `${record.counts.bodies}/${record.counts.coats}/${record.counts.polishes}/${record.counts.inlays}/${record.counts.inspects}`,
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>漆料批次停用召回</h2>
          <p>供应商通报批次停用后，先预览受影响的胎体、道次、打磨、镶嵌与质检，确认后冻结下游并保留原值。</p>
        </div>
        <Space wrap>
          <Button icon={<PlayCircleOutlined />} loading={busy} onClick={() => void handleResume()}>
            重启后续处理（{pendingCount}）
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="召回单总数" value={recalls.length} suffix="份" tone="primary" />
        <StatBadge label="待冻结" value={pendingCount} suffix="份" tone="warning" />
        <StatBadge label="已冻结" value={frozenCount} suffix="份" tone="info" />
        <StatBadge label="在用批次" value={batches.filter((b) => b.status === 'active').length} suffix="个" tone="success" />
        <StatBadge label="停用批次" value={batches.filter((b) => b.status === 'inactive').length} suffix="个" tone="danger" />
      </div>

      {pendingCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${pendingCount} 份召回单停留在「待冻结」（可能因上次中断）`}
          description="冻结为单事务，不会留下半套标记；点击右上角「重启后续处理」可把这些召回单继续冻结到完成。"
          action={<Button size="small" loading={busy} onClick={() => void handleResume()}>继续处理</Button>}
        />
      ) : null}

      <Card size="small" style={{ marginBottom: 14 }}>
        <Space wrap>
          <Typography.Text strong>选择被通报停用的批次：</Typography.Text>
          <Select
            showSearch
            style={{ minWidth: 320 }}
            placeholder="选择漆料批次"
            value={previewBatchId || undefined}
            options={batches.map((batch) => ({
              value: batch.id,
              label: `${batch.batchNo} · ${PAINT_TYPE_LABEL[batch.paintType]}${batch.colorName} · ${
                PAINT_BATCH_STATUS_LABEL[batch.status]
              }`,
            }))}
            onChange={(value: string) => {
              setPreviewBatchId(value);
              void runPreview(value);
            }}
          />
          <Button icon={<NotificationOutlined />} type="primary" disabled={!preview} onClick={openNotice}>
            录入通报并冻结
          </Button>
        </Space>
      </Card>

      {preview ? (
        preview.counts.bodies === 0 ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 14 }}
            message={`批次 ${preview.batchNo} 当前没有可追溯到的使用记录`}
            description={`可能该批次尚未领用，或仅关联到「${UNTRACED_LABEL}」的旧数据；仍可录入通报停用批次，但不会冻结下游记录。`}
          />
        ) : (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 14 }}
            message={`预览：批次 ${preview.batchNo} 将影响 ${preview.counts.bodies} 个胎体、${preview.counts.coats} 条道次、${preview.counts.polishes} 条打磨、${preview.counts.inlays} 条镶嵌、${preview.counts.inspects} 条质检`}
            description="确认录入通报后，这些下游记录会在单个事务内整体冻结并保留原值；冻结失败会整体回滚，不留半套标记。"
          />
        )
      ) : null}

      {preview ? (
        <Row gutter={[12, 12]}>
          <Col xs={24} xl={12}>
            <Card size="small" title={`受影响胎体（${preview.bodies.length}）`} styles={{ body: { padding: 0 } }}>
              <Table rowKey="id" size="small" pagination={{ pageSize: 4 }} columns={bodyColumns} dataSource={preview.bodies} />
            </Card>
          </Col>
          <Col xs={24} xl={12}>
            <Card size="small" title={`受影响道次（${preview.coats.length}）`} styles={{ body: { padding: 0 } }}>
              <Table rowKey="id" size="small" pagination={{ pageSize: 4 }} columns={coatColumns} dataSource={preview.coats} />
            </Card>
          </Col>
          <Col xs={24} xl={8}>
            <Card size="small" title={`受影响打磨（${preview.polishes.length}）`} styles={{ body: { padding: 0 } }}>
              <Table rowKey="id" size="small" pagination={{ pageSize: 3 }} columns={polishColumns} dataSource={preview.polishes} />
            </Card>
          </Col>
          <Col xs={24} xl={8}>
            <Card size="small" title={`受影响镶嵌（${preview.inlays.length}）`} styles={{ body: { padding: 0 } }}>
              <Table rowKey="id" size="small" pagination={{ pageSize: 3 }} columns={inlayColumns} dataSource={preview.inlays} />
            </Card>
          </Col>
          <Col xs={24} xl={8}>
            <Card size="small" title={`受影响质检（${preview.inspects.length}）`} styles={{ body: { padding: 0 } }}>
              <Table rowKey="id" size="small" pagination={{ pageSize: 3 }} columns={inspectColumns} dataSource={preview.inspects} />
            </Card>
          </Col>
        </Row>
      ) : null}

      <Card className="gb-table-card" style={{ marginTop: 16 }} title="召回单台账（同一通报只生成一份）" styles={{ body: { padding: 0 } }}>
        <Table rowKey="id" size="small" pagination={{ pageSize: 6 }} columns={recallColumns} dataSource={recalls} />
      </Card>

      <Modal
        open={noticeOpen}
        title="供应商批次停用通报"
        onCancel={() => setNoticeOpen(false)}
        onOk={() => void confirmFreeze()}
        okText="确认并冻结下游"
        cancelText="取消"
        confirmLoading={busy}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="batchId" hidden>
            <Input />
          </Form.Item>
          <Form.Item
            name="noticeNo"
            label="供应商通报号"
            rules={[{ required: true, message: '同一通报号只生成一份召回单' }]}
            tooltip="同一通报号重复提交会复用已有召回单，不会重复冻结"
          >
            <Input placeholder="如：SUP-2026-031" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="noticeDate" label="通报日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
            <Form.Item name="source" label="通报来源" style={{ flex: 1 }}>
              <Input placeholder="如：供应商电话 / 邮件" />
            </Form.Item>
          </Space>
          {preview ? (
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="批次号">{preview.batchNo}</Descriptions.Item>
              <Descriptions.Item label="受影响记录">
                胎体 {preview.counts.bodies} · 道次 {preview.counts.coats} · 打磨 {preview.counts.polishes} · 镶嵌{' '}
                {preview.counts.inlays} · 质检 {preview.counts.inspects}
              </Descriptions.Item>
            </Descriptions>
          ) : null}
          <Alert
            style={{ marginTop: 12 }}
            type="error"
            showIcon
            message="确认后该批次停用，下游记录整体冻结并保留原值，禁止继续编辑。"
          />
        </Form>
      </Modal>
    </div>
  );
}
