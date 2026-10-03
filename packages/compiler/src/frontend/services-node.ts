import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { FrontendServices } from "./services.js";
import { Ts7Api, ts7Executable } from "./ts7/rpc-api.js";
import { evaluateNodeComptime } from "./comptime-node.js";
import { emitRuntimeTypeScript } from "../native/runtime-typescript.js";

export function createNodeFrontendServices(): FrontendServices {
  return new FrontendServices((options) => new Ts7Api(options), process.cwd(), evaluateNodeComptime, {
    resolve: (fromFile, specifier, paths) => {
      const require = createRequire(pathToFileURL(fromFile));
      return paths === undefined ? require.resolve(specifier) : require.resolve(specifier, { paths: [...paths] });
    },
    lookupPaths: (fromFile, specifier) => createRequire(pathToFileURL(fromFile)).resolve.paths(specifier),
  }, (path, source, format) => emitRuntimeTypeScript(ts7Executable(), path, source, format));
}

let shared: FrontendServices | undefined;
/** Standalone Node utilities share a lazy parser whose transport closes at
 * process exit. Compilation loads create and dispose their own services. */
export function nodeFrontendServices(): FrontendServices { return shared ??= createNodeFrontendServices(); }
