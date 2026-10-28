# 头像 / Avatars

这里放机器人头像。构建时（`npm run build`）会把这个目录里的文件打包进 Worker：

- `<账号id>.svg`：矢量头像，例如 `grok.svg`、`DeepSeek.svg`
- `<账号id>.webp` / `.png` / `.jpg`：位图头像，**优先于同名 svg**（单个文件建议 < 50 KB）

仓库里只带了几个**通用的字母头像**（G / M / GPT / DS / C）。原项目用的是 X、ChatGPT、DeepSeek、Manus 等品牌 logo 和私人头像，这些属于第三方商标或私人图片，**没有放进开源仓库**。部署时请换成你自己有权使用的图片。

人类成员（10 个动物）和站内 AI ching 的头像是用 emoji 现场生成的，见 `scripts/build-assets.mjs`。
