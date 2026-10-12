import { buildAnalysisUnits } from "./shared/segments";
import type { Message } from "./shared/types";
let n = 0;
const msg = (ts: string): Message => ({ id: "m" + ++n, sender: "other", text: "哈喽" + n, timestamp: ts, kind: "text" });
const messages: Message[] = [];
for (const d of [0, 10, 20, 30, 40, 50]) {
  const day = 1 + Math.floor(d / 3);
  const month = 7 + Math.floor(d / 30);
  for (let k = 0; k < 5; k++) messages.push(msg(`2026年${month}月${day}日 12:00`));
}
const units = buildAnalysisUnits(messages);
console.log(units.map((u) => u.label + ":" + u.messages.length));
