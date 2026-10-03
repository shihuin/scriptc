import { FrontendServices } from "../../../packages/compiler/src/frontend/services.js";
import { createNativeTs7Api } from "../../../packages/compiler/src/frontend/ts7/native-api.js";
import { runFrontendServices } from "./frontend-services-cases.js";
import { emitRuntimeTypeScript } from "../../../packages/compiler/src/native/runtime-typescript.js";

const services = new FrontendServices((options) => createNativeTs7Api({ ...options, executable: process.argv[2]! }),
  process.cwd(), undefined, undefined,
  (path, source, format) => emitRuntimeTypeScript(process.argv[2]!, path, source, format));
try { runFrontendServices(services, process.argv[3]!, process.argv[4]!); }
finally { services.close(); }
