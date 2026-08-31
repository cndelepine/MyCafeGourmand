import path from "node:path";
import { serializeJson } from "./files";
import { checkRecipeAuthoring } from "./check";
import {
  createNewRecipe,
  type NewRecipeDependencies
} from "./new";
import {
  createRecipeReport,
  formatRecipeReport,
  serializeRecipeReport
} from "./report";
import {
  serializeRecipeJsonSchema,
  writeRecipeJsonSchema
} from "./schema-output";

type OptionKind = "boolean" | "string";

function parseOptions(
  values: readonly string[],
  supported: Readonly<Record<string, OptionKind>>
) {
  const result: Record<string, boolean | string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === undefined || !argument.startsWith("--") || argument === "--") {
      throw new Error(`Unexpected positional argument: ${argument ?? "<missing>"}`);
    }
    const key = argument.slice(2);
    const kind = supported[key];
    if (kind === undefined) {
      throw new Error(`Unknown command-line option: --${key}`);
    }
    if (result[key] !== undefined) {
      throw new Error(`Duplicate command-line option: --${key}`);
    }
    if (kind === "boolean") {
      result[key] = true;
      continue;
    }
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for command-line option: --${key}`);
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

function requiredString(options: Record<string, boolean | string>, key: string) {
  const value = options[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required command-line option: --${key}`);
  }
  return value;
}

const topLevelHelp = `Usage: npm run recipes -- <command> [options]

Commands:
  new       Validate and optionally create one authored v2 recipe
  report    Print the deterministic catalog and translation report
  schema    Print or update the persisted recipe JSON Schema
  check     Validate catalog formatting, behavior, and schema drift

Run "npm run recipes -- <command> --help" for command options.
`;

const commandHelp = {
  new: `Usage: npm run recipes -- new --input <file> [--id <uuid>] [--created-at <RFC3339>] [--write]

Validates strict human-authored input and the complete prospective catalog.
Without --write, prints the exact destination and document without changing files.
`,
  report: `Usage: npm run recipes -- report [--json]

Prints a read-only deterministic catalog, provenance, translation-gap, and field-usage report.
`,
  schema: `Usage: npm run recipes -- schema [--write]

Prints the deterministic persisted v1/v2 JSON Schema. --write updates its checked-in file.
`,
  check: `Usage: npm run recipes -- check

Validates content behavior, canonical JSON formatting, deterministic reporting, and schema drift.
`
} as const;

export type RecipeCliDependencies = NewRecipeDependencies & {
  readonly repositoryRoot?: string;
  readonly writeOutput?: (value: string) => void;
};

export async function runRecipeCli(
  argv: readonly string[],
  dependencies: RecipeCliDependencies = {}
) {
  const writeOutput = dependencies.writeOutput
    ?? ((value: string) => process.stdout.write(value));
  const repositoryRoot = path.resolve(
    dependencies.repositoryRoot ?? process.cwd()
  );
  const command = argv[0];
  if (
    command === undefined
    || command === "help"
    || command === "--help"
  ) {
    if (argv.length > 1) {
      throw new Error(`Unexpected positional argument: ${argv[1]}`);
    }
    writeOutput(topLevelHelp);
    return;
  }
  if (!(command in commandHelp)) {
    throw new Error(`Unknown recipes command: ${command}`);
  }
  const commandArgs = argv.slice(1);
  if (commandArgs.length === 1 && commandArgs[0] === "--help") {
    writeOutput(commandHelp[command as keyof typeof commandHelp]);
    return;
  }

  if (command === "new") {
    const options = parseOptions(commandArgs, {
      input: "string",
      id: "string",
      "created-at": "string",
      write: "boolean"
    });
    const result = await createNewRecipe({
      input: requiredString(options, "input"),
      ...(typeof options.id === "string" ? { recordId: options.id } : {}),
      ...(typeof options["created-at"] === "string"
        ? { createdAt: options["created-at"] }
        : {}),
      write: options.write === true
    }, {
      ...dependencies,
      repositoryRoot
    });
    writeOutput(serializeJson(result));
    return;
  }

  if (command === "report") {
    const options = parseOptions(commandArgs, { json: "boolean" });
    const report = createRecipeReport(
      dependencies.recipesRoot
        ?? path.join(repositoryRoot, "content", "recipes")
    );
    writeOutput(options.json === true
      ? serializeRecipeReport(report)
      : formatRecipeReport(report));
    return;
  }

  if (command === "schema") {
    const options = parseOptions(commandArgs, { write: "boolean" });
    if (options.write === true) {
      const schemaPath = await writeRecipeJsonSchema(repositoryRoot);
      writeOutput(`Wrote ${path.relative(repositoryRoot, schemaPath)}\n`);
    } else {
      writeOutput(serializeRecipeJsonSchema());
    }
    return;
  }

  parseOptions(commandArgs, {});
  const result = checkRecipeAuthoring(repositoryRoot);
  writeOutput(`Validated ${result.records} recipe document(s).\n`);
}
