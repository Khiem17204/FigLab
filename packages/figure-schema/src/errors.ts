export type ObjectId = string;
export type ArtboardId = string;
export type AssetId = string;

export type FigureDocumentDecodeErrorCode = "INVALID_DOCUMENT" | "UNSUPPORTED_SCHEMA_VERSION";

export class FigureDocumentDecodeError extends Error {
  readonly code: FigureDocumentDecodeErrorCode;
  readonly details: string[];

  constructor(code: FigureDocumentDecodeErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = "FigureDocumentDecodeError";
    this.code = code;
    this.details = details;
  }
}
