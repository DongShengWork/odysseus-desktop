#!/usr/bin/env python3
"""Simple line-by-line English comment → Chinese translation for chatRenderer.js"""
import sys

with open('static/js/chatRenderer.js', 'r') as f:
    lines = f.readlines()

# Map: exact original line (with \n) → translated line (with \n)
T = {}

# File header
T["// static/js/chatRenderer.js\n"] = "// static/js/chatRenderer.js\n"
T["// Extracted from chat.js — message rendering, sources, images, metrics\n"] = "// 从 chat.js 提取 — 消息渲染、引用来源、图片、性能指标\n"

# Sanitize URL
T["/** Sanitize a URL for use in href — only allow http(s) and protocol-relative. */\n"] = "/** 对用于 href 的 URL 进行安全过滤 — 仅允许 http(s) 和协议相对路径。 */\n"
T["  } catch(e) { /* invalid URL */ }\n"] = "  } catch(e) { /* 无效的 URL */ }\n"

# Attachment helpers
T["// Attachment card helpers\n"] = "// 附件卡片辅助函数\n"
T["  // Default: generic document\n"] = "  // 默认：通用文档图标\n"

# Build attach cards
T["// Build the `.attach-cards` element for a message's attachment list. Shared by\n"] = "// 构建消息附件列表的 `.attach-cards` 元素。由 addMessage 和\n"
T["// addMessage and updateMessageAttachments so a live (optimistic) user bubble\n"] = "// updateMessageAttachments 共享，使实时（乐观）用户气泡在\n"
T["// can be re-rendered with real upload ids once the upload resolves.\n"] = "// 上传完成后可以用真实上传 ID 重新渲染。\n"
T["      // Image preview. Shown for both uploaded (att.id present) and still-\n"] = "      // 图片预览。对已上传（有 att.id）和仍在\n"
T["      // uploading attachments. A shimmering skeleton + whirlpool fills the\n"] = "      // 上传中的附件都显示。闪烁骨架 + 漩涡填充\n"
T["      // space until either the upload resolves (no id yet) or the thumbnail\n"] = "      // 空间，直到上传解析完成（尚无 id）或缩略图\n"
T["      // image finishes loading, so the photo doesn't pop in abruptly.\n"] = "      // 图片加载完成，避免照片突然弹出。\n"
T["          // Tapping the corner OCR button shouldn't also open the lightbox.\n"] = "          // 点击角落 OCR 按钮不应同时打开灯箱。\n"
T["        // Skeleton placeholder with a centered whirlpool. Self-stops when removed.\n"] = "        // 骨架占位符，带居中漩涡。被移除时自动停止。\n"
T["        // Match the photo's aspect ratio when the backend knew it at upload\n"] = "        // 在上传时后端已知宽高比时，匹配照片的宽高比，\n"
T["        // time, so the skeleton doesn't sit at a 4:3 default and then snap to\n"] = "        // 避免骨架以 4:3 默认比例显示，然后在图片到达时\n"
T["        // a portrait shape when the image arrives.\n"] = "        // 突然变为竖版形状。\n"
T["        // Small cached thumbnail — the preview is tiny, no need to pull the\n"] = "        // 小缩略图缓存 — 预览很小，无需拉取\n"
T["        // full-resolution photo. Click still opens the full image.\n"] = "        // 全分辨率照片。点击仍会打开完整图片。\n"
T["        // Cached images can be complete before the load listener attaches.\n"] = "        // 缓存的图片可能在 load 监听器附加之前就已加载完成。\n"
T["        // Failsafe: if neither load nor error fires within 8s, reveal anyway.\n"] = "        // 保底：如果 8 秒内 load 和 error 都没触发，仍然显示。\n"
T["        // The timer is cleared on reveal AND when updateMessageAttachments\n"] = "        // 显示时清除计时器，updateMessageAttachments 替换卡片时\n"
T["        // replaces the card (which scrubs the img / skel from the DOM), so\n"] = "        // （会从 DOM 中移除 img / skel 元素）也清除，因此\n"
T["        // repeated re-renders don't accumulate stranded timers.\n"] = "        // 重复重新渲染不会累积孤立的计时器。\n"
T["          // Small corner button → opens the vision/OCR editor so the user can\n"] = "          // 小角落按钮 → 打开视觉/OCR 编辑器，使用户可以\n"
T["          // correct what the vision model extracted. The edit is cached on the\n"] = "          // 更正视觉模型提取的内容。编辑缓存于\n"
T["          // server keyed by file id, so any later message referencing this same\n"] = "          // 服务器，以文件 ID 为键，因此此后引用同一\n"
T["          // image picks up the corrected text instead of re-running the model.\n"] = "          // 图片的消息会获取更正后的文本，而无需重新运行模型。\n"

# updateMessageAttachments
T["// Re-render the attachment cards of an already-rendered message. Used to swap\n"] = "// 重新渲染已渲染消息的附件卡片。用于将\n"
T["// in real upload ids (and image thumbnails) on the optimistic user bubble once\n"] = "// 真实上传 ID（和图片缩略图）换入乐观用户气泡，\n"
T["// uploadPending() resolves — otherwise image previews only appear after a\n"] = "// 在 uploadPending() 解析后 — 否则图片预览仅在\n"
T["// refresh, because the bubble is rendered before the upload assigns ids.\n"] = "// 刷新后出现，因为气泡在上传分配 ID 之前渲染。\n"

# Lightbox
T["// Quick full-size preview when the user taps a chat photo thumbnail. Just an\n"] = "// 用户点击聊天照片缩略图时的快速全尺寸预览。\n"
T["// overlay with the original image centered — no Gallery panel, no editor.\n"] = "// 居中显示原始图片的覆盖层 — 无 Gallery 面板，无编辑器。\n"
T["  // Show the cached thumb immediately so the overlay doesn't sit blank\n"] = "  // 立即显示缓存的缩略图，避免覆盖层在 25MB 原始图片\n"
T["  // while a 25MB original streams in. The full image swaps in once loaded;\n"] = "  // 流式加载时显示空白。完整图片加载后替换；\n"
T["  // if the full load fails (404 / network), we keep the thumb + show an\n"] = "  // 如果完整加载失败（404 / 网络），保留缩略图 + 显示\n"
T["  // error label rather than a blank overlay forever.\n"] = "  // 错误标签，而非永远显示空白覆盖层。\n"
T["  // If the overlay is removed via any path other than our close handler\n"] = "  // 如果覆盖层通过非关闭处理程序的路径被移除\n"
T["  // (session switch, parent re-render, external cleanup), still drop the\n"] = "  // （会话切换、父元素重新渲染、外部清理），仍然移除\n"
T["  // document-level keydown listener so it doesn't leak.\n"] = "  // 文档级 keydown 监听器，防止泄漏。\n"

# Vision/OCR editor
T["// Vision/OCR editor modal — opened from the corner \"Aa\" button on a chat photo\n"] = "// 视觉/OCR 编辑器模态框 — 从聊天照片缩略图的角落 \"Aa\" 按钮打开。\n"
T["// thumbnail. Lets the user view and correct the text the vision model fed to\n"] = "// 让用户查看和更正视觉模型提供给 LLM 的文本\n"
T["// the LLM (e.g. when OCR misreads a word). Persists to the server's vision\n"] = "// （例如 OCR 误读单词时）。持久化到服务器的视觉\n"
T["// cache (PUT /api/upload/{id}/vision), so any subsequent message that\n"] = "// 缓存（PUT /api/upload/{id}/vision），因此任何后续\n"
T["// references the same file picks up the corrected text.\n"] = "// 引用同一文件的消息都会获取更正后的文本。\n"
T["  // Eye icon matches the one in Settings → Vision so users recognise where\n"] = "  // 眼睛图标与设置 → 视觉中的图标匹配，让用户识别此文本来源。\n"
T["  // this text originates.\n"] = "  //\n"
T["  // Regenerate-message: save the edited text, close, then trigger a resend of\n"] = "  // 重新生成消息：保存编辑后的文本，关闭，然后触发重新发送\n"
T["  // the user message so the new AI reply uses the edit immediately.\n"] = "  // 用户消息，使新的 AI 回复立即使用编辑结果。\n"
T["  // ESC closes the popup. Registered on document so it works regardless of\n"] = "  // ESC 关闭弹出窗口。注册在 document 上，使其无论焦点在哪里都能工作\n"
T["  // focus (the textarea swallows the event otherwise).\n"] = "  // （否则 textarea 会吞掉该事件）。\n"

# Tool call regex patterns
T["// Tool call syntax patterns to strip from displayed text\n"] = "// 从显示文本中剥离的工具调用语法模式\n"
T["// Only strip fenced tool-call blocks that look like structured invocations, not regular code examples\n"] = "// 仅剥离看起来像结构化调用的围栏工具调用块，而非普通代码示例\n"
T["// XML-style tool calls: <minimax:tool_call>, <tool_call>, <function_call>, bare <invoke>\n"] = "// XML 风格的工具调用：<minimax:tool_call>、<tool_call>、<function_call>、裸 <invoke>\n"
T["// DeepSeek \"DSML\" tool-call markup (fullwidth-pipe ｜ or ascii | delimited) that\n"] = '// DeepSeek "DSML" 工具调用标记（全角竖线 ｜ 或 ascii | 分隔），\n'
T["// leaks into content when the model emits a text tool call instead of a native\n"] = "// 当模型发出文本工具调用而非原生调用时泄漏到内容中。\n"
T["// one. Strip the whole block; the second pattern catches stray/partial tags\n"] = "// 剥离整个块；第二个模式捕获杂散/部分标签\n"
T["// (e.g. mid-stream before the closing tag arrives).\n"] = "// （例如流传输中在闭合标签到达之前）。\n"
T["// Self-narration about tool results (model echoing stdout/exit_code)\n"] = "// 关于工具结果的自述（模型回显 stdout/exit_code）\n"

# Model pricing
T["// Model pricing table — per million tokens\n"] = "// 模型定价表 — 每百万 token\n"
T["// Model info: pricing (per 1M tokens) + context window length\n"] = "// 模型信息：定价（每 1M token）+ 上下文窗口长度\n"
T["// Compat alias\n"] = "// 兼容别名\n"
T["// Image generation cost lookup (per-image, by model × quality × size)\n"] = "// 图像生成成本查询（每张图片，按模型 × 质量 × 尺寸）\n"

# Strip extensions
T["  // Strip .gguf extension\n"] = "  // 剥离 .gguf 扩展名\n"
T["  // Strip quantization suffixes (Q4_K_M, Q8_0, etc.) and shard numbers\n"] = "  // 剥离量化后缀（Q4_K_M、Q8_0 等）和分片编号\n"
T["  // Truncate if still too long (keep first meaningful part)\n"] = "  // 如果仍然太长则截断（保留第一个有意义的部分）\n"
T["    // Try to find a natural break point (dash after model size like -35B or -7B)\n"] = "    // 尝试找到自然断点（模型大小后的破折号，如 -35B 或 -7B）\n"

# Model color JSDoc
T["/**\n"] = None  # Skip prefix
T[" * Generate a consistent HSL color for a model name.\n"] = " * 为模型名称生成一致的 HSL 颜色。\n"
T[" * Returns an hsl() string. The hue is derived from a string hash,\n"] = " * 返回 hsl() 字符串。色相由字符串哈希派生，\n"
T[" * saturation and lightness are fixed for readability on dark/light themes.\n"] = " * 饱和度和亮度固定，以保证在暗色/亮色主题下的可读性。\n"

# Model info
T["/** Look up model info (pricing + context) by substring match */\n"] = "/** 通过子字符串匹配查找模型信息（定价 + 上下文） */\n"

# Apply model color
T[" * Apply model color to a role element (sets color + dot color).\n"] = " * 将模型颜色应用到角色元素（设置颜色 + 圆点颜色）。\n"
T["  // Replace generic dot with provider logo if available\n"] = "  // 如果可用，用提供商 logo 替换通用圆点\n"
T["  // Click to show model info popup\n"] = "  // 点击显示模型信息弹窗\n"
T["      // Provider = the serving endpoint, distinct from the model vendor/logo\n"] = "      // Provider = 服务端点，与模型供应商/logo 区分\n"
T["      // (e.g. the same model via OpenRouter vs Copilot vs Anthropic direct).\n"] = "      // （例如同一模型通过 OpenRouter vs Copilot vs Anthropic 直连）。\n"
T["      // Show static context initially, then fetch real from server\n"] = "      // 先显示静态上下文，然后从服务器获取真实数据\n"
T["      // Fetch real context from server async\n"] = "      // 异步从服务器获取真实上下文\n"
T["      // Show configured max tokens if set\n"] = "      // 如果已设置，显示配置的最大 token 数\n"

# isLocalEndpoint
T[" * Is this endpoint a local / self-hosted model server (vLLM, Ollama, …)?\n"] = " * 此端点是否为本地/自托管模型服务器（vLLM、Ollama 等）？\n"
T[" * Local models are free, so we must NOT bill them at cloud rates — the\n"] = " * 本地模型免费，因此不能按云端费率计费 — \n"
T[" * pricing table matches on a name substring, so a local `qwen2.5-coder`\n"] = " * 定价表按名称子串匹配，因此本地 `qwen2.5-coder`\n"
T[" * would otherwise be charged like cloud `qwen2.5`. When the serving host is\n"] = " * 否则会被按云端 `qwen2.5` 收费。当服务主机为\n"
T[" * loopback, a private LAN range, Tailscale CGNAT (100.64–100.127.x), a\n"] = " * 回环地址、私有局域网范围、Tailscale CGNAT（100.64-100.127.x）、\n"
T[" * `.local` name, or the app's own host, the model is local → free.\n"] = " * `.local` 名称或应用自身主机时，模型为本地 → 免费。\n"
T[" * Unknown / missing endpoint also counts as local (bias to not over-bill).\n"] = " * 未知/缺失端点也视为本地（偏向不过度计费）。\n"
T["  // A single-label hostname (no dot) is an internal/Docker service name\n"] = "  // 单标签主机名（无点号）是内部/Docker 服务名称\n"
T["  // (e.g. \"nim-nano\", \"llamaswap\", \"nemotron-super-49b\") or a LAN shortname —\n"] = '  // （例如 "nim-nano"、"llamaswap"、"nemotron-super-49b"）或 LAN 短名称 —\n'
T["  // never a public API, which always needs an FQDN. Treat as local → free.\n"] = "  // 绝非公共 API（公共 API 总是需要 FQDN）。视为本地 → 免费。\n"
T["  // (Without this, container-name endpoints get billed at cloud rates because\n"] = "  // （没有此步骤，容器名称端点会因定价表按名称\n"
T["  // the pricing table matches on a name substring, e.g. \"nemotron\".)\n"] = '  // 子串匹配而被按云端费率计费，例如 "nemotron"。）\n'

# Cost
T["/** Cost for the current turn, returning null for non-billable endpoints. */\n"] = "/** 当前轮次的成本，对不可计费端点返回 null。 */\n"
T["/* ── Session cost helpers ─────────────────────────────────────────── */\n"] = "/* ── 会话成本辅助函数 ─────────────────────────────────────────── */\n"
T["/** Return the accumulated cost for the current (or given) session. */\n"] = "/** 返回当前（或指定）会话的累计成本。 */\n"
T["/** Reset session cost for the given session (defaults to current). */\n"] = "/** 重置指定会话的成本（默认为当前会话）。 */\n"
T["  } catch (_e) { /* ignore */ }\n"] = "  } catch (_e) { /* 忽略 */ }\n"
T["      } catch (_e) { /* ignore */ }\n"] = "      } catch (_e) { /* 忽略 */ }\n"
T["/** Update the persistent session-cost badge in the input bar. */\n"] = "/** 更新输入栏中持久化的会话成本徽章。 */\n"
T["  // Non-billable endpoint? Hide the badge and clear stale cost that a previous\n"] = "  // 不可计费端点？隐藏徽章并清除之前云端费率计算\n"
T["  // cloud-rate calculation may have left in localStorage for this session.\n"] = "  // 可能留在 localStorage 中的此会话过期成本。\n"

# roleTimestamp
T["/** Create a timestamp span for role labels.\n"] = "/** 为角色标签创建时间戳 span 元素。\n"
T[" * Pass an ISO string / Date / epoch-ms to render the message's own time\n"] = " * 传入 ISO 字符串 / Date / epoch-ms 以渲染消息自身的时间\n"
T[' * (used when replaying history). Falls back to "now" when no value is given. */\n'] = ' * （用于回放历史记录）。未提供值时回退到"现在"。 */\n'

# stripToolBlocks
T[" * Strip tool invocation blocks from text before rendering.\n"] = " * 在渲染前从文本中剥离工具调用块。\n"

# buildSourcesBox
T[" * Build a collapsible sources box (used by both research and web search).\n"] = " * 构建可折叠的来源框（研究和网页搜索均使用）。\n"

# buildRagSourcesBox
T[" * Build the RAG \"Sources (N documents)\" box — mirrors the live render in\n"] = ' * 构建 RAG "Sources (N documents)" 框 — 镜像\n'
T[" * chat.js so persisted rag_sources survive a refresh. Items carry a\n"] = " * chat.js 中的实时渲染，使持久化的 rag_sources 在刷新后保持。\n"
T[" * filename, similarity %, and snippet (not URLs, unlike web sources).\n"] = " * 条目包含文件名、相似度 % 和片段（与网页来源不同，不含 URL）。\n"

# buildFindingsBox
T[" * Build a collapsible \"Raw collected findings\" section, styled like the sources box.\n"] = ' * 构建可折叠的"原始收集发现"部分，样式与来源框相同。\n'

# appendReportButton
T["/** Append report button + continue research prompt. */\n"] = "/** 追加报告按钮 + 继续研究提示。 */\n"
T["  // Wrapper holds report button + chat-about button\n"] = "  // 容器包含报告按钮 + 聊天讨论按钮\n"

# Event handling
T["  // Debounce to prevent double-fire from both inline onclick and delegation\n"] = "  // 防抖处理，防止内联 onclick 和委托同时触发\n"
T["// Event delegation for sources toggle (capture phase, handles SVG targets)\n"] = "// 来源切换的事件委托（捕获阶段，处理 SVG 目标）\n"
T["  // Walk up from target manually to handle SVG elements that may not support closest()\n"] = "  // 从目标元素手动向上遍历，处理可能不支持 closest() 的 SVG 元素\n"
T["// Jump-to-entity anchors — the agent emits links like\n"] = "// 跳转到实体的锚点 — agent 发出如下链接：\n"
T["// and the chat-history click delegate turns them into navigation\n"] = "// chat-history 点击委托将它们转换为导航\n"
T["// instead of default in-page anchor jumps. Each prefix routes to the\n"] = "// 而不是默认的页面内锚点跳转。每个前缀通过动态导入路由到\n"
T["// matching module via a dynamic import (avoids circular deps —\n"] = "// 匹配的模块（避免循环依赖 —\n"
T["// sessions.js itself imports chatRenderer.js).\n"] = "// sessions.js 本身导入了 chatRenderer.js）。\n"
T["  // Walk past Text nodes — clicking link text yields a Text node target\n"] = "  // 穿透 Text 节点 — 点击链接文本会产生 Text 节点目标\n"
T["  // whose .closest is undefined, so preventDefault never fires and the\n"] = "  // 其 .closest 未定义，因此 preventDefault 永远不会触发，\n"
T["  // browser performs a default hash-navigation that resets the session.\n"] = "  // 浏览器执行默认的哈希导航，从而重置会话。\n"

# buildImageBubble
T[" * Build a generated-image bubble element.\n"] = " * 构建生成图像气泡元素。\n"
T["    // If we have a gallery id, delete server-side; otherwise just remove\n"] = "    // 如果有 gallery id，从服务端删除；否则仅从聊天中移除\n"
T["    // the bubble from chat (e.g. external DALL-E url that wasn't saved).\n"] = "    // 气泡（例如未保存的外部 DALL-E URL）。\n"

# Welcome screen
T["  // Update send button — switches from muted arrow to + Chat\n"] = "  // 更新发送按钮 — 从静音箭头切换到 + Chat\n"
T["  // Entering the New Chat / welcome state: discard any stale draft left in the\n"] = "  // 进入新聊天 / 欢迎状态：丢弃前一个会话留在输入框中的过期草稿，\n"
T["  // composer from the previous session so the input starts empty (issue #1343).\n"] = "  // 使输入框从空状态开始（issue #1343）。\n"
T["  // Switching between existing sessions loads them directly and does NOT call\n"] = "  // 在现有会话之间切换会直接加载它们，不会调用\n"
T["  // this, so genuine drafts are not erased. Reset the autosized height and fire\n"] = "  // 此函数，因此真实草稿不会被擦除。重置自动调整的高度并触发\n"
T["  // an `input` event so the send button + autosize listeners update.\n"] = "  // `input` 事件，以便发送按钮 + 自动调整大小监听器更新。\n"
T["  // Re-trigger the L→R clip-wipe reveal on the welcome name each time the\n"] = "  // 每次显示欢迎屏幕时重新触发欢迎名称的 L→R 裁剪擦除揭示效果\n"
T["  // welcome screen is shown (new session, deleted last session, etc.) — without\n"] = "  // （新会话、删除最后一个会话等）— 没有这步，\n"
T["  // this, the CSS animation only fires on initial DOM insertion.\n"] = "  // CSS 动画仅在初始 DOM 插入时触发。\n"
T["    // force reflow so the next assignment registers as a new animation\n"] = "    // 强制回流，使下一次赋值被注册为新的动画\n"
T["  // Update send button — switches from + Chat to muted arrow on empty session\n"] = "  // 更新发送按钮 — 在空会话中从 + Chat 切换到静音箭头\n"

# Dynamic action buttons
T["// ── Dynamic action buttons (show 3 most recent, rest under ···) ──\n"] = "// ── 动态操作按钮（显示最近 3 个，其余在 ··· 下）──\n"
T[" * Create a footer row for an AI message with timestamp and action buttons.\n"] = " * 为 AI 消息创建页脚行，包含时间戳和操作按钮。\n"
T["  // Define all available actions: { id, icon, title, className, handler }\n"] = "  // 定义所有可用操作：{ id, icon, title, className, handler }\n"
T["  // Filter out unavailable actions (e.g. TTS when not enabled)\n"] = "  // 过滤不可用的操作（例如未启用时的 TTS）\n"
T["  // Determine which 3 to show: use recent order, fallback to defaults\n"] = "  // 确定显示哪 3 个：使用最近顺序，回退到默认值\n"
T["  // Render visible buttons\n"] = "  // 渲染可见按钮\n"
T["  // Overflow \"···\" button\n"] = '  // 溢出 "···" 按钮\n'
T["      // Toggle overflow menu — close any existing one first (through its own\n"] = "      // 切换溢出菜单 — 先关闭任何已存在的菜单（通过其自身的\n"
T["      // dismiss so the Escape registry entry goes with it).\n"] = "      // dismiss 函数，使 Escape 注册条目随之清除）。\n"
T["      // Position fixed relative to the ··· button\n"] = "      // 相对于 ··· 按钮的 fixed 定位\n"
T["      // Flip down if above viewport\n"] = "      // 如果超出视口上方则向下翻转\n"
T["      // Keep within right edge\n"] = "      // 保持在右边缘之内\n"
T["      // Close on outside click or Escape. The trigger button is treated as\n"] = "      // 在外部点击或按 Escape 时关闭。触发按钮被视为\n"
T["      // \"inside\" so its own click toggles rather than double-fires.\n"] = '      // "内部"，使其自身的点击切换而非重复触发。\n'
T["  // Memory-used indicator pill\n"] = "  // 已用记忆指示器标签\n"
T["      // Close on outside click or Escape (pill click toggles, so it's inside).\n"] = "      // 在外部点击或按 Escape 时关闭（标签点击切换，因此视为内部）。\n"

# User footer
T[" * Create a footer row for a user message with action buttons (same system as AI footer).\n"] = " * 为用户消息创建页脚行，包含操作按钮（与 AI 页脚相同的系统）。\n"

# displayMetrics
T[" * Display performance metrics for a message.\n"] = " * 显示消息的性能指标。\n"
T["  // Nothing useful to show — bail out (only if ALL metrics are missing)\n"] = "  // 没有有用的内容可显示 — 退出（仅当所有指标都缺失时）\n"
T["  // Accumulate session cost (only on fresh metrics, not history reload)\n"] = "  // 累计会话成本（仅针对新指标，历史重载不累计）\n"
T["  // Default: show tok/s if available, else fall back to other stats\n"] = "  // 默认：显示 tok/s（如果可用），否则回退到其他统计信息\n"
T["  // Session total cost\n"] = "  // 会话总成本\n"
T["  // Store real context length for model info popup\n"] = "  // 存储真实上下文长度用于模型信息弹窗\n"
T["  // Context usage ring\n"] = "  // 上下文用量环\n"
T["          // Add a spinner bubble at the bottom of chat\n"] = "          // 在聊天底部添加旋转加载气泡\n"
T["          // Animate the wave\n"] = "          // 动画波浪效果\n"
T["              // Reload session — the compacted history will show\n"] = "              // 重新加载会话 — 压缩后的历史记录将显示\n"
T["              // Scroll to the compacted message (first msg with compacted metadata)\n"] = "              // 滚动到压缩消息处（带有压缩元数据的第一条消息）\n"
T["  // Position above the ring, right-aligned\n"] = "  // 定位在环上方，右对齐\n"

# addMessage
T[" * Add a message to the chat history.\n"] = " * 向聊天历史添加消息。\n"
T["    // --- Agent multi-bubble reconstruction from saved metadata ---\n"] = "    // --- 从保存的元数据重建 Agent 多气泡 ---\n"
T["          // Check if this is the last text round — sources go on top of final response\n"] = "          // 检查是否为最后一个文本轮次 — 来源放在最终响应的顶部\n"
T["          // RAG document sources — restored on the final text round.\n"] = "          // RAG 文档来源 — 在最终文本轮次中恢复。\n"
T["          // Reuse previous thread if no text separated us (merge consecutive tool rounds)\n"] = "          // 如果没有文本隔开我们则复用前一个线程（合并连续的工具轮次）\n"
T["            // Extend line up if there's a chat bubble above\n"] = "            // 如果上面有聊天气泡则向上延伸线条\n"
T["            // File-write/edit diff (persisted in the tool event) \\u2014 re-render it\n"] = "            // 文件写入/编辑差异（持久化在工具事件中）——重新渲染\n"
T["            // so it survives reload, matching the live stream.\n"] = "            // 使其在重新加载后保持，匹配实时流。\n"
T["                // Drop the leading diff marker (+/-/space) — colour encodes add/del.\n"] = "                // 丢弃前导差异标记（+/-/空格）——颜色编码增/删。\n"
T["              }).join('');  // spans are display:block \\u2014 a literal \\n would double-space\n"] = "              }).join('');  // spans 是 display:block ——字面的 \\n 会导致双倍行距\n"
T["            // Hide the raw JSON command when a diff says it better (same as live).\n"] = "            // 当差异能更好地表达时隐藏原始 JSON 命令（同实时处理）。\n"
T["            // Click handling is delegated globally \\u2014 see chat.js init.\n"] = "            // 点击处理是全局委托的——参见 chat.js init。\n"
T["          // Check if next round has text — extend line down to connect\n"] = "          // 检查下一个轮次是否有文本——向下延伸连接线以连接\n"

# Wake-task
T["    // --- Wake-task / supervisor system check-in ---\n"] = "    // --- 唤醒任务 / supervisor 系统检查 ---\n"
T['    // The self-wake mechanism injects "Did you finish?" as a user message\n'] = '    // 自我唤醒机制将 "Did you finish?" 作为用户消息注入\n'
T['    // (or persisted history shows a "[Task] Self-check: <id>" envelope)\n'] = '    // （或持久化历史显示 "[Task] Self-check: <id>" 信封）\n'
T["    // so the agent loop re-enters and re-checks status. Render as a\n"] = "    // 使 agent 循环重新进入并重新检查状态。渲染为\n"
T["    // normal user-style bubble — same chrome as a real user message,\n"] = "    // 普通用户风格气泡——与真实用户消息相同的界面装饰，\n"
T['    // just with role "Supervisor" and a short summary body — instead of\n'] = '    // 只是角色为 "Supervisor" 并带有简短摘要正文——而非\n'
T["    // a slim system chip. Matches chat style and integrates cleanly\n"] = "    // 一条精简的系统芯片。匹配聊天风格，干净地融入\n"
T["    // into the conversation flow.\n"] = "    // 对话流。\n"
T['      // Also catch historical messages persisted as "[Task] Self-check: <sid>"\n'] = '      // 同时捕获历史上持久化保存为 "[Task] Self-check: <sid>" 的消息\n'
T["      // (older wake tasks that didn't set wake_check_in metadata).\n"] = "      // （未设置 wake_check_in 元数据的旧版唤醒任务）。\n"
T["      // Supervisor self-check messages are an internal control signal —\n"] = "      // Supervisor 自我检查消息是内部控制信号——\n"
T["      // skip rendering entirely so they don't show up in the conversation.\n"] = "      // 完全跳过渲染，使其不出现在对话中。\n"

# Standard single-bubble
T["    // --- Standard single-bubble message ---\n"] = "    // --- 标准单气泡消息 ---\n"
T["    // For user messages, pull out vision-model image descriptions ([Image: name]\\n\n"] = "    // 对于用户消息，提取视觉模型图像描述（[Image: name]\\n\n"
T['    // <multi-line desc>) into a collapsible "image description" section. Done for\n'] = '    // <多行描述>）到可折叠的"图像描述"部分。对\n'
T["    // ALL user messages (not just ones with attachment metadata) so it rebuilds\n"] = "    // 所有用户消息（不仅仅是有附件元数据的）都这样做，以便\n"
T["    // from the stored text even after a browser restart drops the cached attachments.\n"] = "    // 即使在浏览器重启后缓存的附件丢失，仍能从存储的文本重建。\n"
T["    // With attachments present, also strip the embedded file/PDF/image-marker text.\n"] = "    // 存在附件时，也剥离嵌入的文件/PDF/图像标记文本。\n"
T["      // Strip === File: ... === blocks, [PDF content]: blocks, and [Image attached: ...] lines\n"] = "      // 剥离 === File: ... === 块、[PDF content]: 块和 [Image attached: ...] 行\n"
T["    // Prepend sources box if saved in metadata\n"] = "    // 如果在元数据中保存了来源框，则前置\n"
T["    // RAG document sources — restored from metadata so they survive refresh.\n"] = "    // RAG 文档来源 — 从元数据恢复，使其在刷新后保持。\n"
T["    // If thinking is stored in metadata (not in text), reconstruct the full display\n"] = "    // 如果 thinking 存储在元数据中（而非文本中），重建完整显示\n"
T["    // The vision/OCR caption is stripped from the displayed text above (so the\n"] = "    // 视觉/OCR 标题已从上述显示文本中剥离（因此\n"
T["    // bubble doesn't show the raw model output) but no longer rendered as an\n"] = "    // 气泡不显示原始模型输出），但不再渲染为\n"
T['    // inline collapsible — the user can still view/edit it via the "Caption"\n'] = '    // 内联可折叠 — 用户仍可通过照片缩略图上的 "Caption"\n'
T["    // button on the photo thumbnail. _visionBlocks is intentionally left unused\n"] = "    // 按钮查看/编辑。有意保留 _visionBlocks 未使用\n"
T["    // so the parsing-and-strip side-effect on `text` still happens.\n"] = "    // 以便对 `text` 的解析和剥离副作用仍然生效。\n"
T['    // Add "Open Visual Report" button for persisted research messages\n'] = '    // 为持久化的研究消息添加"打开视觉报告"按钮\n'
T["    // Style [Doc edit: ...] prefix in user messages\n"] = "    // 在用户消息中样式化 [Doc edit: ...] 前缀\n"
T["      // Match compact format: [Doc edit: line X] instruction\n"] = "      // 匹配紧凑格式：[Doc edit: line X] 指令\n"
T['      // Match raw format: "In the document, edit this specific text (line X):\\n```\\n...\\n```\\n\\nInstruction: ..."\n'] = '      // 匹配原始格式："In the document, edit this specific text (line X):\\n```\\n...\\n```\\n\\nInstruction: ..."\n'
T["      // After markdown processing this becomes a <p> + <pre><code> block + <p>Instruction: text</p>\n"] = "      // markdown 处理后变为 <p> + <pre><code> 块 + <p>Instruction: text</p>\n"
T['        // Extract instruction text (after "Instruction: ")\n'] = '        // 提取指令文本（"Instruction: " 之后）\n'
T["      // Render attachment cards\n"] = "      // 渲染附件卡片\n"

# Stopped/Continue
T["    // Add stopped indicator + continue button for messages that were stopped by user\n"] = "    // 为被用户停止的消息添加停止指示器 + 继续按钮\n"
T['      // Differentiate between "stopped mid-stream" (had content, can continue)\n'] = '      // 区分"流中停止"（有内容，可以继续）\n'
T['      // and "cancelled before any content" — the latter has no Continue affordance.\n'] = '      // 和"在有任何内容之前取消" — 后者没有继续功能。\n'
T["      // Continue button only makes sense when there's partial content to\n"] = "      // 继续按钮仅在存在部分内容需要恢复时才有意义——\n"
T["      // resume from \\u2014 skip it for fully-cancelled (empty) turns.\n"] = "      // 对完全取消（空）的轮次跳过。\n"

# Variant navigation
T["    // Restore variant navigation from saved metadata\n"] = "    // 从保存的元数据恢复变体导航\n"
T["      // Re-render from `raw` markdown rather than trusting cached `v.html`.\n"] = "      // 从 `raw` markdown 重新渲染，而非信任缓存的 `v.html`。\n"
T["      // Variants ride through localStorage / chat export-import; cached HTML\n"] = "      // 变体通过 localStorage / 聊天导出导入传输；缓存的 HTML\n"
T["      // would let an attacker-controlled session JSON inject markup.\n"] = "      // 会使攻击者控制的会话 JSON 注入标记。\n"
T["      // Show the selected variant's content\n"] = "      // 显示选中变体的内容\n"
T["      // Render nav\n"] = "      // 渲染导航\n"

# Memories pill
T['      // The "N pinned" / "N recalled" pill in the footer reads from\n'] = '      // 页脚中的"N pinned" / "N recalled" 标签从\n'
T["      // wrap._memoriesUsed — propagate it from saved metadata so the pill\n"] = "      // wrap._memoriesUsed 读取——从保存的元数据传播，使标签\n"
T["      // survives a page refresh (live-stream path sets it via SSE, but\n"] = "      // 在页面刷新后仍然存在（实时流路径通过 SSE 设置，但\n"
T["      // history reloads need this assignment).\n"] = "      // 历史重载需要此赋值）。\n"
T["      // Add timestamp to user header (like AI messages)\n"] = "      // 向用户头部添加时间戳（如同 AI 消息）\n"
T["    // TTS is now part of the msg-actions system\n"] = "    // TTS 现在是 msg-actions 系统的一部分\n"

# Gallery editor
T["      // Ensure the Gallery modal is open so the editor has a container\n"] = "      // 确保 Gallery 模态框已打开，使编辑器有容器\n"
T["      // to render into; switch its tabs to the Edit tab.\n"] = "      // 可以渲染；将其标签切换到编辑标签。\n"

# Apply translations
count = 0
result = []
for line in lines:
    if line in T and T[line] is not None:
        result.append(T[line])
        count += 1
    else:
        result.append(line)

with open('static/js/chatRenderer.js', 'w') as f:
    f.writelines(result)

print(f"Translated {count} lines in chatRenderer.js")
