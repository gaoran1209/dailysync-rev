import * as fs from 'fs';
import * as path from 'path';

/**
 * 轻量加载仓库根目录的 .env（不引入 dotenv 依赖）。已存在的环境变量优先，
 * 这样命令行上临时覆盖（FOO=bar yarn xxx）依然有效。
 *
 * 必须在 import 任何会在模块顶层读 env 的模块**之前**调用——本项目里
 * constant.ts / sqlite.ts 都是 import 期求值的。所以入口文件的写法固定为：
 *   loadDotEnv();
 *   const { xxx } = require('./yyy');   // 用 require 延迟加载，不要用 import
 */
export function loadDotEnv(envPath = path.resolve(__dirname, '../../.env')): void {
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = val;
    }
}
