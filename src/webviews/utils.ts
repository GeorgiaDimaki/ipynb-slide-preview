import { Source } from './types'; // Depends only on the new types file

export function sourceToString(source: Source): string {
    return Array.isArray(source) ? source.join('\n') : source;
}