// CSV reading — the import's first step, run twice with the same code: in the
// browser for instant feedback on upload, and again on the server, which never
// trusts the client's parse. Isomorphic on purpose: no server-only imports, no
// Node APIs.
//
// RFC 4180 plus what real exports do:
//   - quoted fields, "" as an escaped quote, newlines inside quotes;
//   - CRLF and LF line endings (and a lone CR), a UTF-8 byte-order mark;
//   - blank lines (including a trailing one) are skipped, not read as records;
//   - the delimiter is detected: comma, semicolon (European Excel) or tab.
// Line numbers in errors and on rows are the PHYSICAL line in the file where
// the record starts (1-based), so a founder can find it in their editor even
// when a quoted field spans several lines.

export type CsvDelimiter = "," | ";" | "\t";

/** 5 MB of UTF-8 — generous for a billing export, small enough for one request. */
export const CSV_MAX_BYTES = 5 * 1024 * 1024;
/** Data rows, header excluded. */
export const CSV_MAX_ROWS = 20_000;

export interface CsvParseError {
  /** 1-based physical line where the problem starts. */
  readonly line: number;
  readonly message: string;
}

export interface CsvParseResult {
  readonly delimiter: CsvDelimiter;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** `rowLines[i]` is the physical line on which `rows[i]` starts. */
  readonly rowLines: readonly number[];
  /** Problems that stop the file from being read (limits, an unterminated quote, no header). */
  readonly errors: readonly CsvParseError[];
}

/** UTF-8 size without Node's Buffer, so the browser can check before sending. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The delimiter of the header line: whichever of , ; TAB occurs most often
 * outside quotes. Ties and headers with none of them fall back to comma.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && (char === "\n" || char === "\r")) {
      break;
    } else if (!quoted && (char === "," || char === ";" || char === "\t")) {
      counts[char] += 1;
    }
  }
  if (counts[";"] > counts[","] && counts[";"] >= counts["\t"]) return ";";
  if (counts["\t"] > counts[","] && counts["\t"] > counts[";"]) return "\t";
  return ",";
}

function failed(delimiter: CsvDelimiter, error: CsvParseError): CsvParseResult {
  return { delimiter, headers: [], rows: [], rowLines: [], errors: [error] };
}

export function parseCsv(input: string, options: { readonly delimiter?: CsvDelimiter } = {}): CsvParseResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = options.delimiter ?? detectDelimiter(text);

  if (utf8Length(text) > CSV_MAX_BYTES) {
    return failed(delimiter, {
      line: 1,
      message: `The file is larger than ${CSV_MAX_BYTES / 1024 / 1024} MB. Split it into smaller files and import them one after another.`,
    });
  }

  const records: string[][] = [];
  const recordLines: number[] = [];
  let field = "";
  let record: string[] = [];
  /** Inside a quoted field. Text after a field's closing quote is kept as-is. */
  let quoted = false;
  let line = 1;
  let recordStart = 1;
  let quoteStart = 1;
  let fieldHasContent = false;

  const endField = (): void => {
    record.push(field);
    field = "";
    fieldHasContent = false;
  };
  const endRecord = (): void => {
    endField();
    // A blank line is one empty field: skip it rather than read it as a record.
    if (!(record.length === 1 && record[0] === "")) {
      records.push(record);
      recordLines.push(recordStart);
    }
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === "\n" || (char === "\r" && text[i + 1] !== "\n")) line += 1;
        field += char;
      }
      continue;
    }

    if (char === '"' && !fieldHasContent) {
      quoted = true;
      fieldHasContent = true;
      quoteStart = line;
      continue;
    }
    if (char === delimiter) {
      if (record.length === 0 && field === "" && !fieldHasContent) recordStart = line;
      endField();
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      endRecord();
      line += 1;
      recordStart = line;
      if (records.length > CSV_MAX_ROWS + 1) {
        return failed(delimiter, {
          line,
          message: `The file has more than ${CSV_MAX_ROWS.toLocaleString("en-US")} rows. Split it into smaller files and import them one after another.`,
        });
      }
      continue;
    }
    if (record.length === 0 && field === "" && !fieldHasContent) recordStart = line;
    field += char;
    fieldHasContent = true;
  }

  if (quoted) {
    return failed(delimiter, {
      line: quoteStart,
      message: "A quoted value starts here and is never closed. Check for a missing closing quote (\").",
    });
  }
  // The last record, when the file does not end with a newline.
  if (field !== "" || fieldHasContent || record.length > 0) endRecord();

  if (records.length === 0) {
    return failed(delimiter, { line: 1, message: "The file is empty." });
  }
  const [headerRecord, ...dataRecords] = records;
  if (dataRecords.length > CSV_MAX_ROWS) {
    return failed(delimiter, {
      line: recordLines[CSV_MAX_ROWS + 1] ?? 1,
      message: `The file has more than ${CSV_MAX_ROWS.toLocaleString("en-US")} rows. Split it into smaller files and import them one after another.`,
    });
  }

  return {
    delimiter,
    headers: (headerRecord ?? []).map((header) => header.trim()),
    rows: dataRecords,
    rowLines: recordLines.slice(1),
    errors: [],
  };
}
