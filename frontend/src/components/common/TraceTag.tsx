/**
 * <TraceTag> 漆料批次追溯标签
 * 道次使用的漆料批次可追溯时显示批次号；旧数据没有批次标记为「未追溯」。
 * 被髹涂道次页、召回预览等消费。
 */
import { Tag, Tooltip } from 'antd';
import { LinkOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import { UNTRACED_BATCH_ID, UNTRACED_LABEL } from '@/types/paint';

export interface TraceTagProps {
  /** 漆料批次 id；空 / 未追溯常量时展示「未追溯」 */
  batchId?: string | null;
  /** 批次号文案（可追溯时展示） */
  batchNo?: string | null;
  /** 是否停用批次 */
  inactive?: boolean;
}

export function isUntraced(batchId?: string | null): boolean {
  return !batchId || batchId === UNTRACED_BATCH_ID;
}

export function TraceTag({ batchId, batchNo, inactive = false }: TraceTagProps) {
  if (isUntraced(batchId)) {
    return (
      <Tooltip title="旧数据未登记漆料批次，标记为未追溯">
        <Tag icon={<QuestionCircleOutlined />} color="default">
          {UNTRACED_LABEL}
        </Tag>
      </Tooltip>
    );
  }
  return (
    <Tooltip title={inactive ? '该批次已被供应商通报停用' : '已追溯到漆料批次'}>
      <Tag icon={<LinkOutlined />} color={inactive ? 'error' : 'cyan'}>
        {batchNo || batchId}
      </Tag>
    </Tooltip>
  );
}

export default TraceTag;
