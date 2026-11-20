import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { QueueClient } from "@vercel/queue";

// Emit a sibling Build Output function without intercepting Nitro's /api routes.
const dir=".vercel/output/functions/settlement-watch.func";
await mkdir(dir,{recursive:true});
await build({entryPoints:["scripts/queue/settlement-watch.mjs"],outfile:dir+"/index.cjs",bundle:true,platform:"node",format:"cjs",target:"node24",footer:{js:"module.exports = module.exports.default;"}});
await writeFile(dir+"/.vc-config.json",JSON.stringify({
  runtime:"nodejs24.x",handler:"index.cjs",launcherType:"Nodejs",shouldAddHelpers:false,maxDuration:120,
  experimentalTriggers:[{type:"queue/v2beta",topic:"konviction-settlements",consumer:"settlement-watch",retryAfterSeconds:3}],
}));
if(process.env.VERCEL_ENV==="production" && process.env.VERCEL_OIDC_TOKEN){
  const q=new QueueClient({region:"iad1",deploymentId:null});
  const next=Math.floor(Date.now()/60000)+2;
  await q.send("konviction-settlements",{},{idempotencyKey:"minute-"+next,delaySeconds:Math.ceil((next*60000-Date.now())/1000)});
  console.log("Queued production settlement watcher");
}
