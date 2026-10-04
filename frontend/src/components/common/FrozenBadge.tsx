/**
 * <FrozenBadge> 冻结标记
 * 批次停用召回后，下游记录被冻结并保留原值；被五类业务列表与表单消费，
 * 用于提示「记录已冻结、保留原值、禁止编辑」。
 */
import { Tag, Tooltip } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { isFrozen, type FrozenMeta } from '@/types/frozen';

export interface FrozenBadgeProps {
  record?: FrozenMeta | null;
  /** 冻结前原值文案，传入时在 Tooltip 中展示，体现「保留原值」 */
  originalText?: string;
}

export function FrozenBadge({ record, originalText }: FrozenBadgeProps) {
  if (!isFrozen(record)) return null;
  const tooltip = originalText
    ? `已随批次召回冻结，原值保留：${originalText}`
    : '已随批次召回冻结，原值保留，禁止编辑';
  return (
    <Tooltip title={tooltip}>
      <Tag icon={<LockOutlined />} color="error" style={{ marginInlineEnd: 0 }}>
        已冻结
      </Tag>
    </Tooltip>
  );
}

export default FrozenBadge;
