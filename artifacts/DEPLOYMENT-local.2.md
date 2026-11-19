# 当前 profile 部署记录：0.4.0-local.2

## 已确认

- 用户批准了 @google/genai@2.21.0、protobufjs@7.6.6 的安装脚本后，管理器安装并激活了 0.4.0-local.1，返回 application: applied、warnings: []。
- 首次实际调用 websocket_gateway describe 时，工具边界报告 value is not lossless JSON。
- 在隔离 profile 中增加与工具管线相同的 snapshotJsonValue 校验后，先复现失败，再将管理操作结果转换为与 HTTP 端点相同的 JSON 线格式。
- 修复后的构建、类型检查、81 项回归、两种回环 profile 场景通过。
- 冻结 0.4.0-local.2，并以 0.4.0-local.1 为旧版本完成六阶段隔离升级／恢复／卸载测试。
- 用户另行明确批准重载后，管理器移除旧版并安装 0.4.0-local.2，两步均返回 application: applied、warnings: []。
- Host include:dsh-websocket 存在，客户端 settings.section 的 dsh-websocket 入口 active: true。
- 重载前后用户配置补丁 SHA-256 均为 381E9B64C99A8684D0F270703B6C052D06A530DF277426A42A07851F9136E9AA。
- 已安装的管理代码与候选构建产物 SHA-256 一致：C0840ABDFD41A0D0173BDDC1776EF70326028569403847BC28F379CEE45A43F6；已确认包含 JSON 返回值归一化代码。

## 未通过的实际验收

同一会话在重载后再次调用 websocket_gateway describe，仍收到 value is not lossless JSON。因此，不能声称管理工具已在当前运行实例验收通过，也不能把隔离测试通过解释为实际工具已经正常。

可能涉及当前运行进程或会话保留的旧工具／模块代次，亦可能是隔离环境之外的工具处理链；目前证据不足以确定原因。没有据此继续盲目重装或重启 DSH。下一步应先只读定位实际执行代次及结果边界，而不是再改包管理环境。

## 产物与限制

[0.4.0-local.2 安装包](dsh-websocket-0.4.0-local.2.tgz) SHA-256：

```text
1D08A5F29CF1050B0624641C6141E5FFDCBD1D74976D1B25CA2A36171B00D2CD
```

[隔离生命周期证据](../.tmp/gateway-lifecycle-ci6PFT/lifecycle.jsonl)。

当前准确状态：插件已加载、设置页入口已激活、用户配置已保留，但实际管理工具调用仍有错误，验收未全部通过。没有切换模型，没有真实网关推理测试，没有重启 DSH。
