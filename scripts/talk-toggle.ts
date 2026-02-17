import { callGateway } from "../src/gateway/call.js";

const action = (process.argv[2] ?? "").toLowerCase();
if (action !== "on" && action !== "off") {
  console.error("Usage: node --import tsx scripts/talk-toggle.ts <on|off>");
  process.exit(1);
}

const enabled = action === "on";
const res = await callGateway({
  method: "talk.mode",
  params: { enabled },
});

console.log(`talk.mode ${action}`, res);
