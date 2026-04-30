import { ViewerPayload } from "../parsers/types";

export type FromExtension =
  | { type: "load"; payload: ViewerPayload }
  | { type: "error"; message: string };

export type FromWebview =
  | { type: "ready" }
  | { type: "fileDropped"; name: string; content: string }
  | { type: "openPdb"; id: string };
