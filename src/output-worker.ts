/** Private ESM child entrypoint. Never imports discovery/API code or receives a bearer/home. */
import { runOutputWorker } from "./output-worker-body.js";

runOutputWorker();
