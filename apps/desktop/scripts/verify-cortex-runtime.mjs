/* global fetch */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root=join(import.meta.dirname,"..");const platform=process.argv[2]??process.platform;const arch=process.argv[3]??process.arch;const name=platform==="win32"?"cortex-runtime.exe":"cortex-runtime";const resourceOS=platform==="darwin"?"mac":platform==="win32"?"win":platform;const binary=join(root,"resources","cortex-runtime",`${resourceOS}-${arch}`,name);
if(!existsSync(binary))throw new Error(`Cortex Runtime 产物不存在: ${binary}`);
const child=spawn(binary,[],{stdio:["ignore","pipe","pipe"]});let buffer="";const timeout=setTimeout(()=>{child.kill();throw new Error("Cortex Runtime ready frame 超时")},10_000);
child.stdout.on("data",async(chunk)=>{buffer+=chunk.toString();const newline=buffer.indexOf("\n");if(newline<0)return;clearTimeout(timeout);const ready=JSON.parse(buffer.slice(0,newline));const unauthorized=await fetch(`${ready.address}/v1/health`);if(unauthorized.status!==401)throw new Error(`无 token 健康检查应为 401，实际 ${unauthorized.status}`);const health=await fetch(`${ready.address}/v1/health`,{headers:{Authorization:`Bearer ${ready.token}`}});if(!health.ok)throw new Error(`健康检查失败: ${health.status}`);await fetch(`${ready.address}/v1/shutdown`,{method:"POST",headers:{Authorization:`Bearer ${ready.token}`}});console.log(`[verify-cortex-runtime] ${platform}-${arch} 通过`)});
child.on("exit",(code)=>{if(code!==0)process.exitCode=code??1});
