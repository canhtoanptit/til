export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

export class DigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigestError";
  }
}

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

export class SourceError extends Error {
  readonly source: string;

  constructor(source: string, message: string) {
    super(message);
    this.name = "SourceError";
    this.source = source;
  }
}
