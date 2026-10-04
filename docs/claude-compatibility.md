# Claude Code 版本兼容检查

ccs 使用当前配置的 Claude Code，不会为了兼容检查安装或降级 Claude。原生安装从版本文件名识别版本；官方 npm 安装从 `package.json` 识别版本。无法确认时显示 `0.0.0`，不会用白名单版本代替。

运行 `ccs doctor --lite` 检查本机版本。所有版本的 decoder 都必须通过 112,313 条输入的控制行为对照，包括固定语料和 100,000 条确定性随机输入。

对照覆盖 Win32 输入解码及 ccs 会拦截的控制行为：Ctrl+Z / Ctrl+\ 脱离、Ctrl+C / Ctrl+D、Escape、回车、退格和可打印字符。其余功能键与鼠标事件由 ccs 原样转发，事件名称差异会计数显示。当前验证了 macOS arm64 的 2.1.267 和 2.1.289，并保留原有 2.1.267 基线测试。

`decoder: … control routing verified` 表示这些控制行为通过验证。`UNTESTED_CLAUDE_VERSION` 仍表示整个 Claude 版本没有经过完整会话、界面、Remote Control 和飞书集成测试。未来版本改变代码打包结构、输入语义或 CLI 协议时，仍可能需要更新 ccs；提取失败和控制行为不一致都会返回 FAIL。

检查在有超时限制的子进程中读取已安装的 Claude 二进制，并运行提取的键盘函数；不会启动 Claude 会话、调用模型或读取登录凭据。
