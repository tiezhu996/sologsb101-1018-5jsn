/**
 * <FrozenTag> 召回冻结标记
 * 被胎体页、道次页、打磨页、镶嵌页、质检表消费：冻结记录展示统一标记与召回原因。
 */
import { LockOutlined } from '@ant-design/icons';
import { Tag, Tooltip } from 'antd';
import { FROZEN_TAG_LABEL } from '@/types/freeze';

export interface FrozenTagProps {
  /** 是否冻结 */
  frozen: boolean;
  /** 冻结原因（通报编号 / 批次），悬浮展示 */
  reason?: string | null;
  size?: 'small' | 'default';
}

export function FrozenTag({ frozen, reason, size = 'default' }: FrozenTagProps) {
  if (!frozen) return null;
  const tag = (
    <Tag
      icon={<LockOutlined />}
      color="#59595c"
      style={size === 'small' ? { fontSize: 12, marginInlineEnd: 0 } : undefined}
    >
      {FROZEN_TAG_LABEL}
    </Tag>
  );
  return reason ? <Tooltip title={`冻结原因：${reason}（原值保留，禁止修改）`}>{tag}</Tooltip> : tag;
}

export default FrozenTag;
