export type SearchMode = 'normal' | 'extended' | 'regex';

export type SearchDirection = 'next' | 'previous';

export interface SearchRange {
  start: number;
  end: number;
}

export interface SearchOptions {
  mode: SearchMode;
  matchCase: boolean;
  wrapAround: boolean;
  inSelection: boolean;
  wholeWord: boolean;
}

export interface SearchMatch extends SearchRange {
  index: number;
  text: string;
}

export interface SearchParseResult {
  value: string;
  error?: string;
}

export interface FindMatchesResult {
  matches: SearchMatch[];
  error?: string;
}

function buildRegexFlags(matchCase: boolean, global: boolean): string {
  return `${global ? 'g' : ''}${matchCase ? '' : 'i'}`;
}

function isWordCharacter(character: string | undefined): boolean {
  return Boolean(character && /[\p{L}\p{N}_]/u.test(character));
}

function filterWholeWordMatches(text: string, matches: SearchMatch[]): SearchMatch[] {
  return matches.filter((match) =>
    !isWordCharacter(text[match.start - 1]) && !isWordCharacter(text[match.end])
  );
}

export function parseExtendedSearch(input: string): SearchParseResult {
  let value = '';

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    if (current !== '\\') {
      value += current;
      continue;
    }

    const next = input[index + 1];
    if (next === undefined) {
      value += '\\';
      continue;
    }

    switch (next) {
      case 'n':
        value += '\n';
        index += 1;
        break;
      case 'r':
        value += '\r';
        index += 1;
        break;
      case 't':
        value += '\t';
        index += 1;
        break;
      case '0':
        value += '\0';
        index += 1;
        break;
      case '\\':
        value += '\\';
        index += 1;
        break;
      case 'x': {
        const hex = input.slice(index + 2, index + 4);
        if (!/^[\da-fA-F]{2}$/.test(hex)) {
          return { value: '', error: 'รูปแบบ \\xHH ไม่ถูกต้อง' };
        }
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 3;
        break;
      }
      default:
        value += next;
        index += 1;
    }
  }

  return { value };
}

export function decodeReplacement(input: string, mode: SearchMode): SearchParseResult {
  return mode === 'extended' ? parseExtendedSearch(input) : { value: input };
}

function prepareSearchText(query: string, options: Pick<SearchOptions, 'mode'>): SearchParseResult {
  if (!query) return { value: '', error: 'กรุณาพิมพ์คำที่ต้องการค้นหา' };
  if (options.mode !== 'extended') return { value: query };
  const parsed = parseExtendedSearch(query);
  if (parsed.error) return parsed;
  if (!parsed.value) return { value: '', error: 'คำค้นหาว่างหลังแปลง Extended mode' };
  return parsed;
}

export function findMatchesInText(
  text: string,
  query: string,
  options: SearchOptions,
  range?: SearchRange | null
): FindMatchesResult {
  const safeRange = range
    ? {
        start: Math.max(0, Math.min(range.start, text.length)),
        end: Math.max(0, Math.min(range.end, text.length))
      }
    : { start: 0, end: text.length };

  if (safeRange.end < safeRange.start) {
    [safeRange.start, safeRange.end] = [safeRange.end, safeRange.start];
  }

  const scopedText = text.slice(safeRange.start, safeRange.end);
  const matches: SearchMatch[] = [];

  if (options.mode === 'regex') {
    if (!query) return { matches: [], error: 'กรุณาพิมพ์ regex ที่ต้องการค้นหา' };

    let regex: RegExp;
    try {
      regex = new RegExp(query, buildRegexFlags(options.matchCase, true));
    } catch (error) {
      return {
        matches: [],
        error: error instanceof Error ? `Regex ไม่ถูกต้อง: ${error.message}` : 'Regex ไม่ถูกต้อง'
      };
    }

    let match: RegExpExecArray | null;
    while ((match = regex.exec(scopedText)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      const start = safeRange.start + match.index;
      const end = start + match[0].length;
      matches.push({ start, end, text: match[0], index: matches.length });
    }

    const filteredRegexMatches = options.wholeWord ? filterWholeWordMatches(text, matches) : matches;
    return { matches: filteredRegexMatches.map((match, index) => ({ ...match, index })) };
  }

  const prepared = prepareSearchText(query, options);
  if (prepared.error) return { matches: [], error: prepared.error };

  const needle = options.matchCase ? prepared.value : prepared.value.toLocaleLowerCase();
  const haystack = options.matchCase ? scopedText : scopedText.toLocaleLowerCase();
  let fromIndex = 0;

  while (fromIndex <= haystack.length - needle.length) {
    const foundIndex = haystack.indexOf(needle, fromIndex);
    if (foundIndex < 0) break;

    const start = safeRange.start + foundIndex;
    const end = start + prepared.value.length;
    matches.push({ start, end, text: text.slice(start, end), index: matches.length });
    fromIndex = Math.max(foundIndex + prepared.value.length, foundIndex + 1);
  }

  const filteredMatches = options.wholeWord ? filterWholeWordMatches(text, matches) : matches;
  return { matches: filteredMatches.map((match, index) => ({ ...match, index })) };
}

export function buildReplacementText(
  match: SearchMatch,
  query: string,
  replacement: string,
  options: SearchOptions
): SearchParseResult {
  const decoded = decodeReplacement(replacement, options.mode);
  if (decoded.error) return decoded;

  if (options.mode !== 'regex') return decoded;

  try {
    const regex = new RegExp(query, buildRegexFlags(options.matchCase, false));
    return { value: match.text.replace(regex, decoded.value) };
  } catch (error) {
    return {
      value: '',
      error: error instanceof Error ? `Regex ไม่ถูกต้อง: ${error.message}` : 'Regex ไม่ถูกต้อง'
    };
  }
}
