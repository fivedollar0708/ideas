# 阶段 7 · 使用与验收记录（2026-10-08）

移动端键盘避让、触屏单指/双指交接、性能分档、减少动态效果、F2 面板均已实现。
阶段 7 的代码与自动化检查通过，**iPhone Safari / Android Chrome 真机和“800 条无长帧”仍待验收**。

## 如何灌 800 条

在项目根目录打开两个终端。第一个终端启动本地开发服务：

```powershell
npm run serve
```

第二个终端运行：

```powershell
node scripts/stress.mjs 800 --visible
```

脚本会创建全新的临时 Chrome profile，通过 `window.__nebula.store` 写入 800 条测试记录。
不使用常用浏览器、不登录 GitHub、不修改用户数据。窗口里的 F2 可打开/关闭面板；终端按 Enter 后关闭测试窗口并清理临时 profile。
数字是当前空间未归档想法数，不包含心泡泡。800 条仍显示全部 DOM；801 条开始只显示最大 300 个 + 搜索命中。

其他用法：

```powershell
node scripts/stress.mjs 300,800,801                 # 自动跑三档并输出统计
node scripts/stress.mjs 800 --mobile --visible      # 390×844 + 触屏模拟，不是真机
$env:STRESS_REPORT = "$PWD/stage7-performance.json"  # 可选，保存 JSON
$env:STRESS_SCREENSHOT = "$PWD/stage7.png"           # 可选，末尾打开 F2 并截图
```

本机的 Codex 终端目前没有 npm/Node PATH。可用以下绝对路径，不需要安装新依赖：

第一个终端（在项目根目录）：

```powershell
$nebulaNode = 'C:/Users/fived/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $nebulaNode node_modules/esbuild/bin/esbuild src/main.ts --bundle --format=iife --target=es2022 --outfile=app.js
& 'C:/Users/fived/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' -m http.server 8000 --bind 127.0.0.1
```

第二个终端：

```powershell
& 'C:/Users/fived/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/stress.mjs 800 --visible
```

## 自动化验证

由于 npm 不在 PATH，使用项目本地 esbuild/tsc 与 bundled Node 执行 package.json 中相同的程序和参数。

```text
tsc --noEmit
退出码 0，无错误输出

test/bundle.js
全部通过：341 项

scripts/smoke.mjs
冒烟测试全部通过：192 项

密钥扫描通过（清单来源：git ls-files，共 56 个文件）。
```

冒烟新增 32 项：真实 CDP 触屏单指拖拽、第二指取消单指、双指缩放、页面不随之滚动、输入框真实原生滚动；
模拟 visualViewport resize/offsetTop 与 dvh 已收缩的两种键盘路径；300/800/801 边界、隐藏命中补回与本地数据完整；
原位淡入与交接几何、减少动态效果不进入余温档、F2 面板和禁用危险样式。

原空间隔离的坐标逐位相等断言未改。采样前增加 `settle()`，避免把 A 自己在两次 CDP 调用之间的余温运动算成跨空间影响。

## 帧率测量方法与限制

- Intel Core Ultra 9 285H；本机 Chrome 154；headless；桌面视口 1024×800。
- 测试记录长度混合，初始位置为 (0,0)，使用产品现有带种子的散布逻辑；不是把节点均匀铺开来掩盖初始碰撞成本。
- 每档测两段各约 3 秒：灌数据并 refresh 后立即采样（活跃力场），停稳后仅变换 world 容器模拟平移。
- 统计 rAF 帧间隔、p95、最大间隔、超过 50ms 的帧、主线程 longtask，以及 `field.step` 的耗时。
- 停稳平移测量的是绘制/合成负担，不包含真实 Pointer Events 的事件处理成本。F2 显示的是 rAF 刷新采样，不是力场的计算频率。
- headless 的结果不能证明手机 GPU 或 iOS 键盘行为；手机尺寸模拟也仍使用桌面 CPU。
- 800 条密集初始布局已观察到长帧。因此当前不能宣称达到“桌面/手机无长帧”的验收标准。

最终单独压测（无另一轮冒烟并行）结果：

| 想法数 | DOM 数 | 密集初始布局 fps | 初始布局 p95 / 最大帧间隔 | >50ms 帧数 | 停稳平移 fps |
|---|---:|---:|---|---:|---:|
| 300 | 300 | 53.7 | 33.3 / 116.7ms | 3 | 60.0 |
| 800 | 800 | 39.1 | 49.9 / 200.0ms | 4 | 60.0 |
| 801 | 300 | 56.3 | 17.4 / 50.1ms | 1 | 60.0 |

800 条的 `field.step` p95 为 4.0ms；801 条仍模拟全量物理节点，p95 为 4.9ms。
801 条减为 300 个 DOM 后帧率明显提高，说明 DOM/绘制负担在本次测量里占有重要份额，不能只优化物理循环。

**有依据的桌面估计**：同机同负载，300 条初始活跃期约 50–60fps，800 条约 35–45fps；停稳后的容器平移约 60fps。
这些区间是依据本机 headless 实测作的推测，不是所有桌面设备的保证。
**手机帧率未知**：没有真机 CPU/GPU、热状态与 Safari 数据，不能诚实地给出可承诺的数字。
“通常都能 60fps”没有得到本次测量支持。

另做了 390×844 触屏视口的布局检查并查看截图：800 条显示全部 DOM，底栏与输入框在视口内。
该桌面 Chrome 模拟测得初始活跃期约 49.7fps、最大帧间隔 150.1ms，停稳平移约 60.0fps。
它仍使用同一桌面 CPU，不是手机性能数字，也没有真正弹出 iOS 键盘。
