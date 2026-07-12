# Packages

这里仅存放生成产物，不存放生产源码或正式 Spec。

- `packages/.staging/`：打包时临时组装，自动生成、Git 忽略。
- `packages/releases/`：`.tgz` 输出与本地历史包，Git 忽略。
- 正式 Spec 来源始终是根 `spec/`；打包脚本会复制一份只读快照进入发布包。

统一入口：

```bash
npm run pack:yp
```

不要手工编辑 staging 或 tgz。需要修复时修改源码/Spec，重新验证并重新打包。
