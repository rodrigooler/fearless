import type ts from "typescript";
import type { SqlBindParam, SqlTemplate } from "./handles.js";

/**
 * Parse a TaggedTemplateExpression like `sql\`SELECT id FROM users WHERE id = ${ctx.params.id}\``
 * into a SqlTemplate with `$1, $2, ...` placeholders.
 *
 * Returns null if:
 * - The tag is not the identifier `sql`
 * - The template has substitutions but no expressions (shouldn't happen with valid TS)
 */
export function parseSqlTemplate(
  node: ts.TaggedTemplateExpression,
  source: ts.SourceFile,
  tsApi: typeof ts,
): SqlTemplate | null {
  const tag = node.tag;
  if (!tsApi.isIdentifier(tag) || tag.text !== "sql") {
    return null;
  }

  const template = node.template;
  if (tsApi.isNoSubstitutionTemplateLiteral(template)) {
    return {
      sqlText: template.text,
      params: [],
      start: node.getStart(source),
      end: node.getEnd(),
    };
  }

  // TemplateExpression: head + spans
  const head = template.head.text;
  const parts: string[] = [head];
  const params: SqlBindParam[] = [];

  template.templateSpans.forEach((span, index) => {
    const placeholder = `$${index + 1}`;
    parts.push(placeholder);
    parts.push(span.literal.text);
    params.push({
      expression: span.expression.getText(source),
      index,
    });
  });

  return {
    sqlText: parts.join(""),
    params,
    start: node.getStart(source),
    end: node.getEnd(),
  };
}
