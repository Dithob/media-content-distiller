# Ego Lite 字幕兜底

官方 API/CLI 可用时，不启动 Ego Lite。

只有在 API/CLI 不可用、响应结构不兼容或用户明确要求网页验证时，才在 Ego Lite 中打开 BibiGPT 页面并可见地获取字幕。不要把网页内部 tRPC 方法当作稳定公共 API，不读取 Cookie，不绕过登录、额度或风控。

用户明确要求 Ego Lite 时，网页操作必须留在 Ego Lite，不得静默换成 Chrome、Playwright 或普通爬虫。
