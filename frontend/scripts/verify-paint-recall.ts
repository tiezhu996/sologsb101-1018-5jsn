/* eslint-disable no-console */
import 'fake-indexeddb/auto';
import { initDatabase, db } from '@/utils/db';
import { registerIssue, reconcileAll } from '@/utils/paintLedger';
import {
  buildRecallPreview,
  createAndFreezeRecall,
  resumePendingRecalls,
} from '@/utils/recall';
import { PaintShortageError, PaintBatchInactiveError, UNTRACED_BATCH_ID } from '@/types/paint';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

async function reset(): Promise<void> {
  await db.delete();
  await db.open();
  await initDatabase();
}

async function main(): Promise<void> {
  await reset();

  console.log('— 领用原子扣减 / 超量回滚 —');
  const batchBefore = await db.paintBatches.get('pb_raw_2401');
  const startRemaining = batchBefore!.remainingQtyG;
  const issuesBefore = await db.paintIssues.where('batchId').equals('pb_raw_2401').count();

  // 正常领用
  const ok = await registerIssue({
    batchId: 'pb_raw_2401', stage: 'coat', qtyG: 30, receiver: '测试',
    issueDate: '2026-03-20', bodyId: 'body_01', coatSeq: 2, note: '并发测试',
  });
  check('正常领用返回流水', !!ok.issue.id);
  const batchAfterOk = await db.paintBatches.get('pb_raw_2401');
  check('余量原子扣减', batchAfterOk!.remainingQtyG === startRemaining - 30, `got ${batchAfterOk!.remainingQtyG}`);

  // 超量领用应抛错
  let threw = false;
  try {
    await registerIssue({
      batchId: 'pb_raw_2401', stage: 'coat', qtyG: 999999, receiver: '测试',
      issueDate: '2026-03-20', bodyId: null, coatSeq: null, note: '',
    });
  } catch (error) {
    threw = error instanceof PaintShortageError;
  }
  check('超量领用抛 PaintShortageError', threw);
  const batchAfterFail = await db.paintBatches.get('pb_raw_2401');
  const issuesAfterFail = await db.paintIssues.where('batchId').equals('pb_raw_2401').count();
  check('扣减失败后余量回滚不变', batchAfterFail!.remainingQtyG === startRemaining - 30);
  check('扣减失败后流水不增加（一次回滚）', issuesAfterFail === issuesBefore + 1);

  // 并发两笔，合计超过余量：只允许一笔成功，不超发
  await reset();
  const b0 = await db.paintBatches.get('pb_top_2403');
  const cap = b0!.remainingQtyG; // 800
  const results = await Promise.allSettled([
    registerIssue({ batchId: 'pb_top_2403', stage: 'coat', qtyG: 500, receiver: '甲', issueDate: '2026-03-20', bodyId: null, coatSeq: null, note: '' }),
    registerIssue({ batchId: 'pb_top_2403', stage: 'inlay', qtyG: 500, receiver: '乙', issueDate: '2026-03-20', bodyId: null, coatSeq: null, note: '' }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
  const rejected = results.filter((r) => r.status === 'rejected').length;
  const b0After = await db.paintBatches.get('pb_top_2403');
  check('两标签页并发只成功一笔', fulfilled === 1 && rejected === 1, `fulfilled=${fulfilled} rejected=${rejected}`);
  check('并发后用量不超过可用量（不超发）', b0After!.remainingQtyG === cap - 500 && b0After!.remainingQtyG >= 0,
    `remaining=${b0After!.remainingQtyG}`);

  console.log('— 台账对账 —');
  const rec = await reconcileAll();
  const allConsistent = rec.every((item) => item.consistent);
  check('播种数据台账与流水对账一致', allConsistent, JSON.stringify(rec.map((r) => r.diffG)));

  console.log('— 未追溯标记（旧数据） —');
  const untracedCoats = await db.coats.where('paintBatchId').equals(UNTRACED_BATCH_ID).toArray();
  check('body_03 旧道次标记为未追溯', untracedCoats.length === 3, `count=${untracedCoats.length}`);

  console.log('— 批次停用召回：预览 / 冻结 / 幂等 / 保留原值 —');
  await reset();
  const preview = await buildRecallPreview('pb_raw_2401');
  check('预览命中胎体', preview!.bodies.length === 2, `bodies=${preview!.bodies.length}`);
  check('预览命中道次（仅该批次）', preview!.coats.length === 2, `coats=${preview!.coats.length}`);
  check('预览圈定打磨/质检', preview!.polishes.length >= 1 && preview!.inspects.length >= 1);

  const coat0101Before = await db.coats.get('coat_0101');
  const originalState = coat0101Before!.state;
  const r1 = await createAndFreezeRecall({
    noticeNo: 'SUP-001', batchId: 'pb_raw_2401', source: '供应商邮件', noticeDate: '2026-03-21',
  });
  check('首次生成召回单', r1.reused === false && r1.recall.status === 'frozen');

  // 同一通报再次提交 → 复用，不重复
  const r2 = await createAndFreezeRecall({
    noticeNo: 'SUP-001', batchId: 'pb_raw_2401', source: '重复', noticeDate: '2026-03-21',
  });
  check('同一通报只生成一份召回单', r2.reused === true);
  const recallCount = await db.paintRecalls.where('noticeNo').equals('SUP-001').count();
  check('noticeNo 唯一', recallCount === 1);

  // 冻结结果
  const body01 = await db.bodies.get('body_01');
  const coat0101 = await db.coats.get('coat_0101');
  const batch = await db.paintBatches.get('pb_raw_2401');
  check('胎体冻结并保留原状态', body01!.state === 'frozen' && body01!.frozenOriginalState !== undefined);
  check('道次冻结为 recalled 且原值保留', coat0101!.state === 'recalled' && coat0101!.frozenOriginalState === originalState);
  check('批次停用', batch!.status === 'inactive' && batch!.noticeNo === 'SUP-001');
  check('业务原值保留（色名不变）', coat0101!.colorName === '漆黑' && coat0101!.thicknessUm === 40);

  // 停用批次禁止领用
  let inactiveThrew = false;
  try {
    await registerIssue({ batchId: 'pb_raw_2401', stage: 'coat', qtyG: 1, receiver: 'x', issueDate: '2026-03-21', bodyId: null, coatSeq: null, note: '' });
  } catch (e) {
    inactiveThrew = e instanceof PaintBatchInactiveError;
  }
  check('停用批次禁止领用', inactiveThrew);

  console.log('— 重启续处理 pending —');
  await reset();
  // 手工插入一条 pending（模拟冻结事务中途失败）
  const now = Date.now();
  await db.paintRecalls.put({
    id: 'recall_SUP-002', noticeNo: 'SUP-002', batchId: 'pb_color_2402', batchNo: 'C-2402',
    source: '中断模拟', noticeDate: '2026-03-22', status: 'pending',
    affectedBodyIds: ['body_01', 'body_02'],
    counts: { bodies: 2, coats: 2, polishes: 0, inlays: 0, inspects: 0 },
    lastError: null, createdAt: now, updatedAt: now,
  });
  const pendingBefore = await db.paintRecalls.where('status').equals('pending').count();
  check('存在 pending 召回单', pendingBefore === 1);
  const resumed = await resumePendingRecalls();
  check('重启后续处理成功', resumed.resumed === 1 && resumed.failed.length === 0);
  const after = await db.paintRecalls.get('recall_SUP-002');
  check('pending 已转为 frozen', after!.status === 'frozen');
  const c0102 = await db.coats.get('coat_0102');
  check('续处理后道次冻结且保留原值', c0102!.state === 'recalled' && c0102!.frozenOriginalState === 'toPolish');

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail > 0) process.exit(1);
  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
