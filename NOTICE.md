# 来源与修改说明

主体源码、清单、中文翻译和原有 Node / Go 测试来自 [xTreeRoot/MB](https://github.com/xTreeRoot/MB) 的 `plugins/builtin/bilibili`。迁出时以 `android` 分支既有 JS 实现为基础，并保留 `main` 提交 `b9a23c6dd441cdf084921663f4f9f381831ea448` 中的通用账号迁移导出与媒体错误语义；保留根仓库 AGPL-3.0 许可证。本版本是独立维护的衍生作品。

平台接口沿用 MB 已验证实现；首页及音乐区组织最初参考 [GentleM4dman/mygo-music-bilibili](https://github.com/GentleM4dman/mygo-music-bilibili)。没有复制任何用户账号、Cookie、档案或私有存储。

2026-11-21，xTreeRoot：迁出为可独立安装、更新和移除的三端插件；增加通用旧存储兼容、失效会话停用保留、忽略无法中止的迟到响应、账号一致性校验、二维码来源与 Cookie 格式校验，补齐音质选择、备用媒体地址和视频尺寸；扩充独立回归与实际宿主运行时脚本。
