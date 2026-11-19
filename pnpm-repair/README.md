# Windows／pnpm 父目录清理故障：本机修复记录

## 结果

已对当前 DSH 使用的项目内 pnpm 11.28.5 应用官方 PR #16693 的修复回补。它让同一父目录只清理一次，移除了触发 Windows delete-pending EPERM 的重复并行删除，不是靠忽略 EPERM 或限制线程池绕过。

只修改已安装 pnpm 的一个运行文件，未修改 DSH 主源码、pnpm 版本声明、锁文件、全局环境或 Windows 权限。没有安装、卸载或加载 WS 插件，没有重启当前 DSH。

## 上游依据

- [官方修复 PR #16693](https://github.com/pnpm/pnpm/pull/16693)
- [官方 11.28.6 发布说明](https://pnpm.io/blog/releases/11.28.6)：包含该 Windows rmdir EPERM 修复。
- [官方补丁差异](https://patch-diff.githubusercontent.com/raw/pnpm/pnpm/pull/16693.diff)

本机继续报告版本 11.28.5，因为这是对当前固定版本回补一个官方修复，不是伪称升级到了 11.28.6。

## 修改范围

实际入口：[pnpm 运行文件](D:/deepseek-harness/node_modules/.pnpm/pnpm@11.28.5/node_modules/pnpm/dist/pnpm.mjs)。

仅两处逻辑变化：

1. 父目录清理前调用 `selectOneLinkPerParent(staleLinks)`。
2. 加入官方同名 helper，按目标链接父目录去重。

没有改变错误白名单、链接安全校验或失败回滚逻辑。文件通过原子替换写入，以断开可能存在的内容存储硬链接，避免修改共享存储中的原始文件。

## 验证结果

| 阶段 | 观察结果 |
| --- | --- |
| 原实现的确定性 Windows pending-delete 回归 | 成功复现 EPERM |
| 原版真实 pnpm CLI，默认线程池 | 第 2 次强制安装复现 EPERM |
| 修复副本，默认线程池 | 连续 20 次真实强制安装通过 |
| 修复副本，真实本地依赖添加／移除 | 3 轮通过 |
| 真正的权限拒绝注入 | 错误仍被报告，已移除链接仍被恢复，没有吞掉错误 |
| 原子恢复演练 | 独立测试副本恢复后哈希与原文件一致 |
| 应用后的实际 `bin/pnpm.mjs` 入口，默认线程池 | 10 次真实强制安装、3 轮添加／移除全部通过 |
| 当前 profile 文件哈希 | 清单、用户补丁、锁文件、pnpm 工作区配置前后均未改变 |
| 常规 `pnpm --version` | 正常返回 11.28.5 |

所有安装／移除验证只针对新建的本地临时测试工作区，无外部依赖，不执行安装脚本，不操作当前 profile 的依赖。

验证脚本为[隔离验证](verify.mjs)和[实际入口复测](confirm-installed.mjs)。本次通过的原始结果见[验证摘要](backups/pnpm-11.28.5-sFaAXH/verified.json)、[实际入口摘要](backups/pnpm-11.28.5-sFaAXH/installed-verification.json)及[修复计划](backups/pnpm-11.28.5-sFaAXH/plan.json)。

## 哈希与回滚

```text
原文件 SHA-256:
e3738fda08262f74611d7a1ffc11b3e87fa52b466c07eb73211d179ebcb98810

修复后 SHA-256:
50a8da8ca38ec92059be265ad8a7b764a84d9b8bcb5f4880581b5ad8d7598535
```

[回补工具](backport.mjs)保留了原文件备份。需要撤销时，以下命令只在当前 pnpm 文件仍与本次修复哈希相符时恢复，拒绝覆盖他人后续改动：

```powershell
node 'D:\deepseek-harness\local-plugins\plugins\dsh-websocket-next\pnpm-repair\backport.mjs' restore 'D:\deepseek-harness\local-plugins\plugins\dsh-websocket-next\pnpm-repair\backups\pnpm-11.28.5-sFaAXH'
```

## 生效与后续

pnpm 每次管理操作都是新进程，因此该实际入口的下一次调用会读取修复后的代码，不需要重启当前 DSH。其他独立安装的 pnpm 副本未修改。

这是本机已安装依赖的最小修复回补。重装或更新 pnpm 可能覆盖它；长期应在单独授权的维护窗口把项目固定版本升级到包含修复的官方版本，再移除此回补记录。本次没有更改项目声明或触发大范围依赖升级。

本修复只解决已确认的重复父目录清理竞态，不意味着所有安装错误都已消失。WS 插件的依赖构建脚本策略仍需在实际安装时单独决定，未自动批准任何脚本。本次用户请求是修复 pnpm，不包含再次加载插件，因此 WS 插件仍未加载。
