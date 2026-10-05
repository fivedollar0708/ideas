# 想法星云 Nebula · AI 投喂提示词模板

> 配套 `PROJECT-SPEC.md`。  
> 按开发阶段拆分，每段可直接复制使用。

---

## 0. 怎么用这份文件

### 0.1 核心前提

**AI 全程协助 ≠ 每段都重写一遍项目。** 最浪费时间的做法是每开一个新会话都把整个项目描述一遍，那会导致 AI 反复做已做过的决策、反复推翻已定的东西。

正确做法：**一次把规格喂进去，之后每段只喂「阶段 + 上一段的产出 + 这一段的要求」。**

### 0.2 每次开新会话的开场三件套

```
①贴 PROJECT-SPEC.md 的 §1（目标与范围）+ §4（数据模型）
② 说明当前进度：已经完成哪几个阶段
③ 贴本次要做的那一段提示词
```

### 0.3 每段提示词的固定开头

下面每段都以这段开头，**不要删**。它承载的是全项目最容易被 AI 违反的约束：

```
项目：想法星云（Nebula）—— 一个人的灵感收集站，纯静态站，部署在 GitHub Pages。
完整规格见 PROJECT-SPEC.md，请先读一遍再动手。

三条铁律（任何实现决策与它们冲突时，改实现，不改铁律）：
1. 本地先成功，网络后同步。任何录入先在 IndexedDB 事务提交，再异步推 GitHub。
   网络失败 / token 失效 / GitHub 宕机 / 断网，这四种情况用户必须零感知。
2. 仓库里一个字节的密钥都没有。靠白名单 .gitignore + 提交前扫描保证。
3. 数据只有一份真身。真身在 IndexedDB，GitHub 上的是影子，backup 是影子的影子。

技术栈已定，不要改：TypeScript + esbuild + 零框架 + DOM 渲染（不用 canvas）
+ 自写力导向（不用 d3-force）+ IndexedDB + GitHub Contents API。

动手前先回答我三个问题，不要直接写代码：
- 这次改动会碰到哪几个文件？
- 有没有哪个决策是你在猜而规格里没写清的？
- 最容易出错的地方是哪一处？
```

### 0.4 给 AI 的三条禁止项

每次都重申，能省掉大量返工：

```
禁止项：
- 不要引入任何运行时依赖（npm 包）。只用浏览器原生 API。
- 不要引入前端框架（React/Vue/Svelte），也不要引入力导向/动画库。
- 不要用 filter: blur()、常驻 will-change、或改 width/height/left/top 做动画。
  位置与尺寸动画只准动 transform，缩放用 scale 不改宽高。
```

---

## 1. 阶段 0 · 部署链路（先做这个，零代码）

**为什么第一个做**：整条部署链路是唯一"不写代码就不知道能不能成"的部分。提前把唯一未知项打掉。

```
请带我完成阶段 0：打通部署链路。这阶段不写业务代码。

我已完成或请你帮我确认的：
- GitHub 账号 fivedollar0708，SSH 免口令密钥已配好（实测认证通过）
- HTTPS 443 现在是通的，api.github.com 返回 200
- gh CLI 未安装
- 默认分支用 master（我的既有仓库都是 master）

请按顺序给我：
1. 在 GitHub 网页端建仓库 ideas 的逐步操作（public，注意哪些勾不要选）
2. 本地 git init、加remote（用 SSH 地址）、首次提交
3. 一个最小 index.html 占位，push 后确认
4. GitHub Pages 的设置路径：选哪个分支、哪个目录，.nojekyll 有什么作用
5. 确认站点能打开的命令和判断标准

注意：本机 raw.githubusercontent.com 的 TLS 握手被重置，不要依赖这个域。
所有相对路径必须写成 ./app.js 形式，不能用 /app.js，
因为站点在 github.io/ideas/ 这个子路径下。

每一步做完我会告诉你结果，你再给下一步。不要一次性给我全部命令。
```



---

## 2. 阶段 1 · 骨架与数据层

```
请实现阶段 1：项目骨架 + 数据层。

要求：
- package.json（esbuild + typescript，仅 devDependencies）
- tsconfig.json（strict: true）
- 白名单式 .gitignore：先* 全忽略，再逐个 ! 放行
- .nojekyll 空文件
- src/types.ts：Idea / Space / Link / SyncState / Viewport / Rect / Vec
- src/rng.ts：mulberry32 + hashString + makeRng
- src/text.ts：norm / clampText / measureText / radiusOf / scoreMatch
- src/store.ts：IndexedDB 封装，四张表 spaces / ideas / meta / trash
- src/main.ts：最小启动，先只验证"写入→读出"
- test/assert.ts：一个极简断言库 + src/text.ts 的测试

必须遵守的实现要点：
1. 🔴 rng.ts 里为什么不用 Math.random：力导向和布局的随机数必须由种子驱动，
   否则同一批想法每次打开散落到不同位置，位置持久化就形同虚设。
2. 🔴 text.ts 里的 FONT_STACK 是全项目字体的唯一真相来源，canvas 测量和 CSS
   渲染必须共用它。代码里任何地方都不要再写第二份字体栈字面量。
   另外不要用自定义 webfont——加载失败时 fallback 会改变度量，
   让所有缓存的尺寸失效。宁可牺牲排版品味，也要保证测量永远准确。
3. 🔴 Idea 绝不存r/w/h。尺寸由 text 经 radiusOf() 推导，只做内存缓存。
   文本是唯一真相来源 → 数据模型永久免迁移。
4. 🔴 Idea 的 updatedAt 与 movedAt 必须是两个字段。同步合并时
   文本按 updatedAt 比、位置按 movedAt 比，互不干扰。
   如果只有一个时间戳，在 A 拖泡泡会用本地时间戳覆盖 B 上刚改的文本。
5. radiusOf 出来的形状是椭圆不是正圆（正圆塞中文短文本是排版灾难），
   比例约束 1:1 ~ 2:1，迭代两轮让"半径反过来决定可用宽度"收敛。
6. scoreMatch 要支持：完全相等 > 前缀 > 子串 > 字符集重叠。
   字符集重叠是为了让"三点"能命中"凌晨三点"。

交付前请跑 npm run typecheck 和 npm test，把输出贴给我。
然后告诉我：这一版我怎么在浏览器里验证"存进去再读出来"？
```

---

## 3. 阶段 2 · 空间系统与心泡泡

```
请实现阶段 2：多空间系统 + 中心泡泡。

交互规格（用户亲自定的，请严格照做）：
- 每个空间有一个"心泡泡"，它既是空间名字，也是空间切换的唯一入口
- 心泡泡钉在世界坐标原点，不参与运动积分，但作为碰撞体挡住其它泡泡
- 点击心泡泡 → 浮出空间切换层，底层星云变暗，所有空间的心泡泡浮现
- 浮层里双击某个空间泡泡 → 直接重命名
- 浮层里单击 → 切换到该空间
- 浮层底部有「新建空间」「打开回收站」两个入口
- 心泡泡不能被"删除"（删掉它等于删掉整个空间），只提供编辑

数据层要求：
- spaces 表 + ideas.spaceId
- 回收站全局一个：删除空间时空间连同它全部想法进 trash 表，
  trash 里存完整快照（否则恢复不回来）
- 恢复时名字冲突自动加后缀
- 每张表都有 purgeAt，30 天后自动清空
- 第一版没有"删除单个想法"，只有归档（archived=1）

必须遵守的实现要点：
1. 🔴 切换空间时，力导向的邻域查询必须只考虑同 spaceId 的泡泡。
   否则空间间的泡泡会互相排斥，"互不影响"就是假的。
   这是最容易写错的地方，请在 force 的数据结构层面就带上 spaceId 过滤，
   不要在调用方做过滤。
2. 🔴 创建空间时必须立刻切过去吗？规格里没写清。我的建议是：
   新建后直接切到新空间（用户此刻的注意力就在新空间），
   但要把心泡泡的名字默认填成「未命名 N」并聚焦到重命名输入。
   如果你不同意，告诉我理由，我们讨论后再定。
3. 视口（缩放/平移）状态按 spaceId 分别记忆，切换空间时各自恢复。
4. 中心泡泡用 CSS 变量 --accent，按 space.hue 取色，9 个色板循环。

交付前请跑 typecheck 和 test。
然后告诉我：怎么手工验证"三个空间互不影响"？给出具体步骤和预期结果。
```

---

## 4. 阶段 3 · 力导向与泡泡渲染

```
请实现阶段 3：力导向布局 + 泡泡 DOM 渲染 + 拖拽。

力导向要求（三种力，自己写，不用任何库，约 260 行）：
- 斥力：任意两个泡泡之间，距离小于阈值时互推，强度随距离平方反比衰减
- 向心：拉向心泡泡（钉在原点），让星云聚拢不散架
- 碰撞：泡泡之间不能重叠，用椭圆外接矩形判断
- 必须做网格分桶（spatial hash），把 O(n²) 降到 O(n·k)。
  500 个点的全对斥力是 12.5 万次距离计算/帧，JS 里约 1-2ms，
  实测能跑 60fps，所以不需要 Barnes-Hut 四叉树（要多写 120 行，
  第一版不值）。网格分桶是 40 行换 O(n²)→O(n·k)，性价比极高。
- 🔴 不实现 Barnes-Hut。在代码注释里写清"为什么现在不做"，
  免得以后有人以为是漏了。

三档降频（枢纽设计，必须做）：
| 状态 | 条件 | 行为 |
|---|---|---|
| 活跃 | alpha > 0.02 | 每帧 rAF |
| 余温 | 0.002 < alpha <= 0.02 | 每 4 帧跑一次（15fps，CPU 降到 1/4）|
| 静止 | alpha <= 0.002 | 完全停 rAF，CPU 真的是 0 |
| 苏醒 | 拖动/新泡泡落定/resize | alpha = max(alpha, 0.35)，重启 |

拖拽要求（手感最微妙的一段，严格照做）：
1. 拖拽判定用 8px 位移 + 300ms 时长双阈值。低于阈值判定为点击（触发放大）。
2. 🔴 拖拽开始后必须立即停止力导向对这个泡泡的写入。
   否则会出现"压着泡泡一边拖一边抖"。
3. 🔴 松手时不是硬停，而是给它一个甩出速度（vx/vy 由最近几帧位移算出），
   让它自然滑一段再被力场拉住。这是用户原话：
   "默认不立刻定住，松手后会飘一点，让人有拖拽的感觉"。
4. 🔴 只用 Pointer Events 一套代码覆盖鼠标和触屏，不要写两套。
5. 心泡泡永远钉住，不可拖动、不可锁定。
6. 双击泡泡切换 pinned，pinned 的泡泡力场绕过它（斥力和向心都跳过），
   边框从虚线变实线。

渲染要求：
- DOM 渲染，不用 canvas
- element 复用：Map<id, HTMLElement>，不重建
- 🔴 两层元素铁律：.bubble 写 translate3d（力导向每帧），
  .bubble-inner 写 scale（入场/悬停动画）。两者绝不能抢同一个 transform 属性。
  这个分层定下来之前不要写任何动画代码。
- 性能分档：<=300 全开；300-800 关涟漪和 glow、字号降 1px；
  >800 只渲染最大的 300 个 + 搜索命中的。

请同时写 test/physics.ts，至少 8 组断言：
- 两个泡泡重叠时必须被推开
- pinned 的泡泡不被推开
- 心泡泡永不被推开
- alpha 会收敛到 0.002 以下（不会永远抖动）
- 苏醒能把 alpha 提到 0.35
- 不同 spaceId 的泡泡之间不产生作用力
- 网格分桶的结果与暴力计算一致（<0.5% 误差）
- 同一组初始条件跑两次结果完全一致（验证随机数来自种子）

交付前请跑 typecheck 和 test，把输出贴给我。
然后告诉我：物理常数（斥力强度/衰减）你是怎么定的？给出你用的公式和初值，
以及我应该怎么调。诚实告诉我哪些参数是"猜的、需要我眼睛校准"。
```

---

## 5. 阶段 4 · 飞入与放大手感

```
请实现阶段 4：录入飞入动画 + 放大到中央 + 悬停微胀大。

这一段是整个产品的灵魂手感，请慢一点做。

飞入动画要求：
1. 🔴 用影子交接，不能直接用真泡泡做动画。
   原因：真泡泡在 #stage 里已被 translate3d + scale 变换着，
   用它做 offsetPath 会被二次扭曲。
   做法：在 body 下建一个 position:fixed 的影子泡泡（用同一个渲染函数，
   保证像素一致），对它跑 WAAPI offsetPath，完成后销毁影子，
   再在 #stage 里建真泡泡并播 pop 入场。
2. 🔴 offsetPath 的路径坐标是视口绝对坐标，不是相对位移。
   这是最容易写错的点，第一次写必然偏移。
3. 路径用二次贝塞尔：起点是输入框中心，终点是星云内随机点
   （避开心泡泡 200px 内），控制点在起终点中点上方偏移 60-120px 形成弧线。
4. "啵"的落定感靠多停靠点 keyframes：
   scale 走 0.15 → 1.22 → 0.92 → 1.05 → 1，单靠 cubic-bezier 做不出两次过冲。
5. 🔴 选 WAAPI 不选 rAF 的理由：跑在合成线程，主线程同时可以跑力导向。
   请在注释里写明这个理由。
6. 同时播一个 ripple 涟漪（一个 transient 元素，scale 从 0.6 到 2.2 + opacity 1→0）。

放大到中央（FLIP）：
1. First：记录当前 rect
2. Last：算出目标 rect（屏幕中央）
3. Invert：施加反向 transform
4. Play：用 WAAPI 过渡到 identity
5. 🔴 transform-origin 按"指针点击位置与泡泡中心的连线"计算，
   这样泡泡是朝你手指的方向放大。
6. 🔴 放大态的形状分档必须和源一致：文本 <=8 字用圆，>8 字用卡片。
   否则等比缩放会让形状歪掉。
7. 收回触发：再点该泡泡 / 点空白 / 按 Esc。

悬停微胀大：
1. scale 1.0 → 1.04，用 CSS transition
2. 🔴 文字"变清晰"不能用 filter: blur()（几百个元素上就是性能灾难），
   用 opacity 从 .78 到 1 + 去掉 text-shadow 柔化。
   请在注释里写明为什么不用 filter。
3. 🔴 拖拽中的泡泡不能有 hover 效果，否则会一边拖一边变。

请告诉我：
- 飞入总时长我定多少？依据是什么？
- 缩小到 0.15 再弹到 1.22 这个过冲会不会太夸张？
  我需要看着实物判断，你建议我先试哪两个数值？
```

---

## 6. 阶段 5 · 搜索

```
请实现阶段 5：搜索（聚光式，不清场）。

需求要点：
- 🔴 绝不筛选掉未命中的泡泡。筛选会让星云从"一片海"缩成"几个点"，
  而版图就是这个产品存在的意义。搜索是手电筒，不是筛子。
- 命中：恢复正常不透明 + 边框提亮 + scale 1.04
- 未命中：opacity .16（只用 opacity，不要用 filter: blur）
- 命中文字包 <mark> 高亮，🔴 只在搜索词变化时重建 DOM，
  命中时要复用已有的标记节点，否则会闪烁
- 计数显示"⌕ 12 条"
- Enter / Shift+Enter 在命中项间跳转（居中 + 脉冲），
  🔴 不自动飞过去（会打断"一边搜一边想"）
- 🔴 零索引：500 条 x 12 字 = 6000 字符，朴素扫完 <0.1ms。
  不要建倒排索引——换不回成本，还引入"索引与原文不一致"一整类 bug。
  请在注释里写明这个判断。

必须处理的两个易错点：
1. 🔴 中文输入法：debounce 回调开头必须有 if (e.isComposing) return;
   漏了这条，中文输入法打字过程中每个拼音中间态都会触发一次
   全量搜索 + 全量 DOM class 改写，页面会卡死。
2. 🔴 切换空间时搜索结果必须重建，否则会残留上一个空间的命中项。

打分函数 scoreMatch 的权重（完全相等 1000 > 前缀 500 > 子串 200-位置惩罚
> 字符集重叠 x20）已经在 src/text.ts 实现了，你直接用。

交付前跑 typecheck 和 test。
然后给我一份手工验证清单，包含：
搜"三点"、搜"三"、搜"凌晨"、搜不存在、搜单字"水"、
拼音输入法打"lingsant"过程中页面卡不卡、切换空间后搜索结果对不对。
```

---

## 7. 阶段 6 · GitHub 同步（最重要，多花时间在这一段）

```
请实现阶段 6：GitHub 同步。这是整个项目唯一"错了会毁数据"的模块，
单元测试保证不了，请格外小心。

架构（已定，不要改）：
- 本地 IndexedDB 是权威副本，GitHub 是镜像
- 合并算法：记录级 LWW + 集合并集（不做三方合并）
- 三个文件：data/sync.config.json（指针）/ data/ideas.json（镜像）/
  data/ideas.backup.json（回退）

🔴 本机已实测的三个坑，必须处理（我探测过环境）：
1. raw.githubusercontent.com 的 TLS 握手被重置（3/3 失败）。
   → 只用 api.github.com，代码里永不出现 download_url。
2. btoa() 对非 Latin-1 字符抛 InvalidCharacterError，中文同步会全挂。
   → TextEncoder → 分块 0x8000 → String.fromCharCode(...chunk) → btoa。
   展开运算符也有参数上限，必须分块。
   解码方向也要处理：atob → 字节数组 → TextDecoder，不能直接当字符串用。
3. api.github.com 官方支持浏览器 CORS（预检返回
   Access-Control-Allow-Origin: *，Allow-Headers 含 Authorization，
   Allow-Methods 含 PATCH/PUT/DELETE），认证后 5000 req/hour。

🔴 Contents API 的 PUT 必须带 sha 和 committer，缺任一返回 422。

🔴 最恐怖的一类失败必须 fail loud：
解析失败 / content 为空字符串 / encoding 不是 base64（文件>1MB）时，
立即 throw 并把 status 置为 error，绝不进入合并流程。
否则"解析失败 → 解析成空 → 合并成空 → 推上去" = 数据全没。
另外：合并结果为空但本地非空时，拒绝 PUT 并告警。

backup 回退：
- 每次推之前，先读远端 ideas.json，把它一字不改地存到 ideas.backup.json
- sync.config.json 里的 fallbackToBackup: true 用来触发回退。
  🔴 这个 flag 是从远端读的，所以改一行 JSON 就能触发回退，
  不用重新部署代码。这是我故意设计的，请不要改成"需要重新部署"。

合并算法（已定，请实现并写测试）：
- 文本/归档按 updatedAt 比，位置按 movedAt 比，互不干扰
- 幂等、交换、单调
- 🔴 我发现 potential bug：Space 的重命名和新建也需要合并语义，
  你想过吗？Space 没有 movedAt，用 updatedAt 就够。
  但要注意"删除空间"和"另一台设备刚在这个空间加了想法"并发时会怎样？
  请给出你的方案。

同步时机：
- 加载时先渲染本地（0 延迟），后台再拉远端 → 绝不能"等同步完再显示"
- 本地写入 → 60s 防抖标 dirty → 自动推送节流 >= 2h
- visibilitychange:hidden 且 dirty → 推一次
- 手动按钮可绕过节流立即推
- 每次 PUT 都产生一个 commit 且无法关闭 → 缓解：
  先比对内容，相同就完全不 PUT；节流 2h；粗估一年 <110MB
- 并发：navigator.locks.request('nebula-sync', ...) 包住同步临界区，
  BroadcastChannel 通知其它标签页只刷新 UI 不触发同步

合并结果必须反馈到 UI（同步要"可见"，用户才会信任它）：
- 远端带来的新想法 → 从星云边缘飞入 + toast "从备份恢复了 N 条"
- 远端赢了本地 → 泡泡原地闪一下（scale 1 → 1.08 → 1，240ms）
- 本地赢了远端 → 静默标 dirty，不动 UI

token 安全（🔴 最高优先级）：
- 存在 localStorage，用 WebCrypto PBKDF2 + AES-GCM 加密，
  用户自设口令。密钥不落地，只在内存
- 口令必须能设：否则别人打开网站翻 DevTools 就能看到 token
- 仓库里永远没有 token
- 请写 scripts/check-secrets.mjs：提交前扫描 github_pat_ / ghp_ / sk- /
  AKIA 前缀，命中就拒绝提交

请一并写 test/merge.ts，覆盖：
- 纯本地 / 纯远端 / 完全相同 / 文本冲突 / 位置冲突 / 文本与位置分别冲突
- 幂等性：merge(merge(a,b),b) === merge(a,b)
- 交换律：merge(a,b) 的结果集合 === merge(b,a) 的结果集合
- 删除与新增并发时空间不丢想法

交付前跑 typecheck 和 test。
然后给我一份 9 条同步演练的逐步操作手册（我会在真实仓库上逐条做）。
```

---

## 8. 阶段 7 · 移动端与性能

```
请实现阶段 7：移动端适配 + 性能分档。

移动端（🔴 键盘遮挡是这一段的核心难点）：
1. 🔴 iOS Safari 上fixed 定位的输入框在键盘弹起时会被顶出屏幕。
   目前唯一可靠解法是 visualViewport 的 resize 事件：
   监听 visualViewport，写一个 --kb 变量表示键盘高度，
   状态条用 transform: translateY(calc(-1 * var(--kb)))。
   请不要相信 position:fixed 在 iOS 上对键盘可靠。
2. 用 100dvh 而不是 100vh
3. safe-area-inset-bottom 给输入栏留出刘海屏安全区
4. 触屏拖拽必须 preventDefault，否则会同时触发页面滚动。
   但要小心别把正常的滚动也禁掉
5. 双指捏合缩放：必须禁用浏览器的原生 pinch-zoom
   （touch-action 声明 + 手动处理 touch 事件）

性能（这四个坑是实测出来的，必须规避）：
1. 🔴 filter: blur() 和 backdrop-filter 挂在几百个元素上会直接掉到个位数 fps。
   搜索变暗只用 opacity。"文字变清晰"用 opacity .78 + text-shadow 模拟柔化。
2. 🔴 常驻 will-change: transform 会让 500 个泡泡变成 500 个合成层，
   几十 MB 显存，手机掉帧。will-change 只在动画中的那一个元素上加，
   结束移除。
3. 🔴 改 width/height/left/top 做动画会触发布局。位置和尺寸动画
   只准动 transform，缩放用 scale 不改宽高。
4. 巨大的 box-shadow glow 在低性能设备上会卡。放大遮罩的毛玻璃
   只作用在一个全屏元素上，blur <= 8px。

性能分档（写在 render.ts 的一个常量里，方便调）：
- <=300 个泡泡：全开
- 300-800：关涟漪和 glow、字号降 1px
- >800：只渲染最大的 300 个 + 搜索命中的

还要加：
- prefers-reduced-motion: reduce 时，飞入改成淡入，力导向关掉余温档
- 一个开发用的性能面板（按 F2 切换），显示帧率、泡泡数、力导向档位

交付前跑 typecheck 和 test。
然后告诉我：怎么灌 800 条测试数据？给我一个脚本。
以及你在 300/800 两档分别预计能跑多少 fps，依据是什么？诚实标注哪些是猜测。
```



---

## 9. 阶段 8 · AI 能力（第二版）

```
请实现阶段 8：AI 能力的接口预留和本地预筛。这一版不实现真正的 AI 调用。

provider.ts：
- 定义 AIProvider 接口：embed(texts) / collide(pair, allIdeas)
- 实现 noopProvider：所有方法返回空，明确标注"第二版实现"
- 🔴 第一版 UI 里不出现任何 AI 入口，调用不报错，就是全部要求。
  不要画一个灰掉的按钮，那会让用户以为坏了。

similarity.ts（这个要真做，且有测试）：
- 字符 bigram + IDF 加权余弦，纯 JS 零依赖
- 为什么不用 transformers.js 本地 embedding：中文模型 100MB+，
  纯静态站首屏负担太重
- 🔴 长度为 1 的想法（"水"）产生零个 bigram，必须退回 unigram。
  而"水"恰恰最该被碰撞——这是最容易漏的边界情况。
- 三层剪枝：df > 50% 跳过（当作停用 gram）、字符集 Jaccard 快速拒绝、
  共享 gram 数不足拒绝
- 目标：500 条全量预筛 < 30ms，可放主线程，不需要 Worker

🔴 不要把相似度阈值硬编码。我要的是一个探针脚本：
输入 ideas.json，输出相似度最高的 50 对及其分值分布。
我要人眼扫一遍再定阈值。阈值是审美问题，不是数学问题。

请写 test/similarity.ts：
- 单字想法能与相关想法匹配
- 完全相同的想法相似度为 1
- 毫不相干的想法相似度接近 0
- 500 条全量预筛耗时 < 30ms（性能测试，要真的跑）

DeepSeek 接入说明（第二版才用，先写注释说明）：
- base_url: https://api.deepseek.com
- 模型: deepseek-flash（注意 legacy 名 deepseek-v4-flash 仍被接受但
  对应模型已退役，新代码直接用 deepseek-flash）
- 上下文 1M，输入 $0.15/1M（off-peak $0.003，缓存命中便宜 50 倍）
- 中国大陆直连
- 🔴 我实测确认它的 CORS 反射任意 Origin，浏览器可直连。
  注意：网上很多文章说 DeepSeek 不支持浏览器跨域、必须配 Vite 代理，
  那个说法是错的。
- 省钱的两个杠杆：off-peak 时段（北京时间白天，成本减半）
  + 共享前缀让 prompt cache 命中
- 500 条想法两两组合是 124,750 对，必须先本地预筛再送 LLM。
  不要设计成每次全量重发。

交付前跑 typecheck 和 test，并跑一次探针脚本，把 top-20 结果给我看。
```

---

## 10. 阶段 9 · 收尾

```
请完成收尾：

1. README.md（这是给用户自己看的操作手册，不是项目介绍）。
   必须包含 12 节：这是什么 / 怎么记一条 / 怎么搜索 / 怎么开备份（token 4 步图文）
   / 怎么撤销轮换 token / 口令是什么忘了怎么办 / 本地怎么开发 / 怎么部署一次
   / 🔴 数据恢复手册（最重要）/ 大陆访问风险+本地逃生舱 / AI碰撞预告 / 安全边界
   其中"数据恢复手册"必须包含一条**完全不懂技术也能做**的路径：
   直接在 GitHub 网页端打开 data/ideas.backup.json，复制粘贴覆盖
   data/ideas.json，提交。

2. 写 build.cmd 和 serve.cmd（Windows，cmd 语法）。
   🔴 serve.cmd 里必须有 chcp 65001>nul，否则中文乱码。
   🔴 用绝对路径写 esbuild，因为工具链没加进系统 PATH：
   node 在 C:\Users\fived\.workbuddy\binaries\node\versions\22.22.2-3\node.exe
   （实际请用 npx 或先确认 esbuild 的实际路径）

3. 备份输出格式用 .bat 时必须是 CRLF 行尾，LF 行尾的 .bat 会被 cmd 解析乱，
   出现"不是内部或外部命令"这类莫名报错。

4. 最终检查清单（请逐项确认并给出证据）：
   - npm run typecheck 零错误
   - npm test 全绿
   - npm run check:secrets 零命中
   - git status 确认 app.js 已提交且没有多余文件
   - 仓库里搜不到任何 token 痕迹
   - 相对路径全是 ./ 开头，不是 / 开头

5. 告诉我这套东西还差什么、或者哪里我应该重点自己上手试。
```

---

## 11. 附录 A · 随时可用的诊断提示词

### A.1 掉帧

```
效果不流畅，帮我定位。禁止给我"减少泡泡数量"或"降低画质"这种答案，
我要的是找到真正的瓶颈。

请：
1. 先用 DevTools Performance 录一段，说明录制时的泡泡数量
2. 从火焰图判断瓶颈是 layout / paint / composite / script 哪一项
3. 逐条检查这四个已知坑：
   - 有没有 filter: blur() 或 backdrop-filter
   - 有没有常驻 will-change: transform
   - 动画有没有改 width/height/left/top
   - box-shadow blur 半径是不是过大
4. 检查力导向的 alpha 是不是没降到 0.002 以下，导致 rAF 一直不停
5. 给出定位到具体代码行的结论，不要泛泛而谈
```

### A.2 同步丢数据

```
同步出问题，数据可能丢了。请优先保住数据，不要先修代码。

请按这个顺序：
1. 立刻停止一切会写远端的操作（我先手动断开网络或撤销 token）
2. 告诉我怎么从 data/ideas.backup.json 手动恢复
3. 检查合并算法：哪种情况会导致本地记录被远端覆盖掉？
4. 检查有没有"解析失败被当成空数据"这条路径
5. 给出防止复发的最小改动
```

### A.3 排版崩坏

```
泡泡里的文字排版不对：要么溢出、要么挤成一团、要么被椭圆切掉。

请：
1. 确认 FONT_STACK 只有一处定义，且 canvas 测量和 CSS 渲染共用它
2. 确认 radiusOf 的迭代收敛逻辑没写错
3. 确认长文本（>8 字）走卡片形状而不是圆
4. 确认放大态的形状分档和源一致（不然 FLIP 等比缩放会歪）
5. 贴出你修改前后的 radiusOf 数值对比
```

### A.4 不确定规格时

```
你在实现 X，但我发现规格 Y 没说清。

请：
1. 先列出所有可能的方案（包括"需要问用户"这个选项）
2. 给出你的推荐和理由
3. 明确告诉我：这个决策一旦定下来，以后改起来的代价有多大
4. 如果这个决策可逆（改起来便宜），就按你的推荐做，并在代码里
   留一个清晰的注释说明"这里当初是怎么定的"
5. 如果不可逆或有数据风险，停下来问我
```

---

## 12. 附录 B · 全局约定速查（可贴进任何会话）

```
技术栈（已定，不要改）
- TypeScript + esbuild，零运行时依赖
- 无前端框架，无力导向库，无动画库
- DOM 渲染，不用 canvas
- 自写力导向约 260 行，三种力 + 网格分桶 + 三档降频
- IndexedDB 权威 + GitHub Contents API 镜像
- 部署 GitHub Pages，走 SSH push（密钥免口令已配好）

三条铁律
1. 本地先成功，网络后同步
2. 仓库里一个字节的密钥都没有
3. 数据只有一份真身（IndexedDB），其余都是影子

性能四禁
- 禁 filter: blur() / backdrop-filter
- 禁常驻 will-change
- 禁改 width/height/left/top 做动画（只准 transform）
- 禁在几百个元素上加大 blur 半径的 box-shadow

同步四禁
- 禁 raw.githubusercontent.com（本机 TLS 被重置）
- 禁直接 btoa(中文)
- 禁不带 sha 和 committer 就 PUT
- 禁在解析失败时继续走合并流程

随机
- 引擎里禁 Math.random，一律用 makeRng(seed)

路径
- 全部用 ./ 开头，不用 / 开头（站点在子路径下）
```
