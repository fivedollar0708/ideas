/**
 * 全项目共享的类型定义。
 *
 * 这里定义的字段顺序和注释就是"数据契约"，任何改动都要先改 PROJECT-SPEC.md §4。
 */

export type Id = string;

/**
 * 想法泡泡。
 *
 * 🔴 刻意不存 r/w/h（宽高半径）：尺寸永远由 `text` 经 radiusOf() 推导，
 *    只在内存里缓存。这样"文本是唯一真相来源"，数据模型永久免迁移 ——
 *    以后想改排版规则，历史数据不用动一个字节。
 */
export interface Idea {
  id: Id;
  /** 所属空间。空间被删后这里仍指向墓碑 id，直到回收站过期清理。 */
  spaceId: Id;
  /** 1..MAX_TEXT 字。空字符串不允许入库。 */
  text: string;
  createdAt: number;
  /**
   * 文本 / 归档 / 锁定 / 连线开关变化时更新。
   *
   * 🔴 与 movedAt 分离是同步正确性的关键：合并时"文本按 updatedAt 比、
   *    位置按 movedAt 比"，互不干扰。若只有一个时间戳，在 A 处拖泡泡
   *    会用本地时间戳覆盖 B 上刚改的文本。
   */
  updatedAt: number;
  /** 拖拽结束时更新。位置合并只看这个时间戳。 */
  movedAt: number;
  /** 世界坐标，与视野缩放平移无关。阶段 1 恒为 0（力导向在阶段 3 接管）。 */
  x: number;
  y: number;
  /** 1 = 双击锁定，力场绕过它（斥力与向心都跳过）。 */
  pinned: 0 | 1;
  /** 1 = 该泡泡的关联线常驻显示。用户可任意开关任意泡泡。 */
  linksAlwaysOn: 0 | 1;
  /** 1 = 已归档：从星云隐藏，但仍可搜到、仍会同步。归档不等于删除。 */
  archived: 0 | 1;
  /** 第二版预留：AI 认定的关联泡泡 id。 */
  links?: Id[];
  /** 第二版预留：每条关联的说明（AI 为什么把它们连起来）。 */
  linkNotes?: string[];
}

/** 空间。一个空间就是一片独立的星云，有自己的心泡泡。 */
export interface Space {
  id: Id;
  /** 1..SPACE_NAME_MAX 字。也是心泡泡上显示的文字。 */
  name: string;
  /** 心泡泡色板索引 0..8，见 PROJECT-SPEC.md §4.3。 */
  hue: number;
  createdAt: number;
  /** 仅重命名时更新（用 LWW 合并）。 */
  updatedAt: number;
  /** 1 = 已删除但可从回收站恢复。 */
  deleted: 0 | 1;
  /**
   * 删除时写死 `now + TRASH_RETENTION_MS`；未删除时为 0。
   *
   * 🔴 刻意用必填 number 而不是 `number | null`：规格原设计用 null 表示
   *    "永久保留"，与"统一 30 天过期"矛盾。改成必填后，类型本身就排除了
   *    "忘记设过期时间导致回收站永久堆积"这类 bug。
   */
  purgeAt: number;
}

/** 关联线。数据层只存"哪两个泡泡之间有线"，几何在渲染层算。 */
export interface Link {
  a: Id;
  b: Id;
  /** 第二版 AI 写入。空表示这是用户手动连的。 */
  note?: string;
}

/** 回收站条目的种类。 */
export type TrashKind = 'space' | 'idea';

/**
 * 回收站条目。
 *
 * 🔴 必须存**完整快照**（空间本体 + 它的全部想法），不能只存 id ——
 *    否则恢复时想法已经不在库里，恢复回来是个空空间。
 */
export interface TrashEntry {
  /** 快照 id：kind='space' 时是 space.id，kind='idea' 时是 idea.id。 */
  id: Id;
  kind: TrashKind;
  /** 删除时刻。 */
  deletedAt: number;
  /** 到期时刻，超过即可物理清除。 */
  purgeAt: number;
  /** kind='space' 时存在。 */
  space?: Space;
  /** kind='space' 时存在：该空间的全部想法快照。 */
  ideas?: Idea[];
  /** kind='idea' 时存在。 */
  idea?: Idea;
}

export type SyncStatus =
  | 'local-only'
  | 'idle'
  | 'pushing'
  | 'pulling'
  | 'error'
  | 'merged';

/** 同步状态。阶段 1 只定义类型，阶段 6 才接 GitHub。 */
export interface SyncState {
  status: SyncStatus;
  /** 人类可读的原因，绝不吞错。 */
  detail: string;
  lastSyncAt: number | null;
  lastError: string | null;
  /** 本地有改动尚未推送。 */
  dirty: boolean;
  /** 本次同步从远端拿回 / 赢回多少条，用于 UI 反馈。 */
  lastMerged: number;
}

/** 轴对齐矩形，中心点 + 宽高。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Vec {
  x: number;
  y: number;
}

/**
 * 视口变换：world（星云坐标）↔ screen（CSS 像素）。
 * 视口是本机偏好，存在 meta 表 `viewport:<spaceId>`，**不参与同步**。
 */
export interface Viewport {
  /** 缩放倍率，1 = 100%。 */
  scale: number;
  /** world 原点在 screen 上的位置（相对 stage 左上角）。 */
  tx: number;
  ty: number;
}

/** 单个想法的字数上限。超过按此截断。 */
export const MAX_TEXT = 280;

/** 空间名长度上限。 */
export const SPACE_NAME_MAX = 24;

/** 新建空间的默认名前缀，实际为「未命名 1」「未命名 2」… */
export const SPACE_NAME_DEFAULT = '未命名';

/** 回收站保留期：统一 30 天。 */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 心泡泡在世界坐标里被钉住的位置。 */
export const HEART_ORIGIN: Vec = { x: 0, y: 0 };

/** 视口缩放的上下限。 */
export const VIEW_SCALE_MIN = 0.25;
export const VIEW_SCALE_MAX = 3;

// ── 心泡泡的尺寸参数（见 PROJECT-SPEC.md §3.2）──────────────

/**
 * 心泡泡比"同名字的普通泡泡"大一圈，一眼可辨。
 * 🔴 它始终是正圆（不走椭圆）：它是整片星云唯一的锚点，正圆才像球心。
 */
export const HEART_SCALE = 1.15;
export const HEART_MIN_RADIUS = 44;
export const HEART_MAX_RADIUS = 88;

/** 心泡泡只按名字的前 N 个字算尺寸，名字再长也不会把泡泡撑到吃掉半个屏幕。 */
export const HEART_NAME_MEASURE_MAX = 12;

/**
 * 恢复空间时，名字冲突自动加的后缀。
 * 第一次冲突「星际（恢复）」，再冲突「星际（恢复 2）」。
 */
export const SPACE_RESTORE_SUFFIX = '（恢复）';

/**
 * 新泡泡落点的圆环范围。
 *
 * 🔴 上限刻意压得比较小（320）：星云是"以心泡泡为锚点去探索"的，不是一屏看全的。
 *    如果新泡泡散到 400+ 远，在大屏上还看得见，在笔记本的矮窗口里就直接落在视野外，
 *    违背"不想错过任何想法"。按紧了让力导向自己去铺开，比一开始就撒太远好。
 */
export const SPAWN_MIN_RADIUS = 130;
export const SPAWN_MAX_RADIUS = 320;

