import { createPlaybookSimulationHost } from "./playbookSimulationHost.ts";

const execute = createPlaybookSimulationHost();
self.onmessage = (event: MessageEvent<unknown>) => { self.postMessage(execute(event.data)); };
