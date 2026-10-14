import ts from 'typescript';
import type {
  AnalysisRequest,
  AnalysisResult,
  CallResolution,
  Cancellation,
  FunctionDescriptor,
  LanguageAdapter,
  SourceSpan,
  StatementDescriptor,
  StatementKind,
  TextPosition
} from '@visual-code-flow/shared';

function sourceFile(request: AnalysisRequest): ts.SourceFile {
  const kind =
    request.languageId === 'javascript'
      ? ts.ScriptKind.JS
      : request.languageId === 'javascriptreact'
        ? ts.ScriptKind.JSX
        : request.languageId === 'typescriptreact'
          ? ts.ScriptKind.TSX
          : ts.ScriptKind.TS;
  return ts.createSourceFile(request.uri, request.text, ts.ScriptTarget.Latest, true, kind);
}

function span(file: ts.SourceFile, uri: string, node: ts.Node): SourceSpan {
  const start = file.getLineAndCharacterOfPosition(node.getStart(file));
  const end = file.getLineAndCharacterOfPosition(node.getEnd());
  return { uri, start, end };
}

function contains(file: ts.SourceFile, node: ts.Node, position: TextPosition): boolean {
  const offset = file.getPositionOfLineAndCharacter(position.line, position.character);
  return offset >= node.getStart(file) && offset < node.getEnd();
}

function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function nameOf(node: ts.FunctionLikeDeclaration): string {
  if ('name' in node && node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent)) return parent.name.getText();
  }
  return ts.isConstructorDeclaration(node) ? 'constructor' : '<anonymous>';
}

export class TypeScriptLanguageAdapter implements LanguageAdapter {
  readonly supportedLanguages = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'];

  findFunction(request: AnalysisRequest, position: TextPosition): FunctionDescriptor | undefined {
    const file = sourceFile(request);
    let selected: ts.FunctionLikeDeclaration | undefined;
    function visit(node: ts.Node): void {
      if (!contains(file, node, position)) return;
      if (isFunction(node) && node.body) selected = node;
      ts.forEachChild(node, visit);
    }
    visit(file);
    if (!selected || !selected.body) return undefined;
    return {
      symbolId: `${request.uri}#${selected.getStart(file)}`,
      name: nameOf(selected),
      location: span(file, request.uri, selected),
      body: span(file, request.uri, selected.body),
      languageId: request.languageId
    };
  }

  async analyzeFunction(
    request: AnalysisRequest,
    symbol: FunctionDescriptor,
    cancellation?: Cancellation
  ): Promise<AnalysisResult> {
    const file = sourceFile(request);
    const statements: StatementDescriptor[] = [];
    const position = file.getPositionOfLineAndCharacter(
      symbol.location.start.line,
      symbol.location.start.character
    );
    let functionNode: ts.FunctionLikeDeclaration | undefined;
    function visit(node: ts.Node): void {
      if (isFunction(node) && node.getStart(file) === position) {
        functionNode = node;
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    if (!functionNode?.body)
      return { function: symbol, statements, diagnostics: ['Function no longer exists'] };

    const toStatements = (node: ts.Statement): readonly StatementDescriptor[] =>
      ts.isBlock(node) ? node.statements.map(toStatement) : [toStatement(node)];

    const toStatement = (node: ts.Node): StatementDescriptor => {
      let kind: StatementKind = 'sequence';
      if (ts.isIfStatement(node)) kind = 'branch';
      else if (
        ts.isForStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node)
      )
        kind = 'loop';
      else if (ts.isReturnStatement(node)) kind = 'return';
      else if (ts.isThrowStatement(node)) kind = 'throw';
      else if (ts.isBreakStatement(node)) kind = 'break';
      else if (ts.isContinueStatement(node)) kind = 'continue';
      else if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression))
        kind = 'call';
      else if (ts.isSwitchStatement(node) || ts.isTryStatement(node)) kind = 'unsupported';

      const children = ts.isIfStatement(node)
        ? toStatements(node.thenStatement)
        : ts.isForStatement(node) ||
            ts.isForOfStatement(node) ||
            ts.isForInStatement(node) ||
            ts.isWhileStatement(node) ||
            ts.isDoStatement(node)
          ? toStatements(node.statement)
          : undefined;
      const alternate =
        ts.isIfStatement(node) && node.elseStatement ? toStatements(node.elseStatement) : undefined;

      return {
        id: `${request.uri}:${node.getStart(file)}`,
        kind,
        label:
          ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)
            ? node.expression.getText(file).slice(0, 160)
            : node.getText(file).slice(0, 160),
        location: span(file, request.uri, node),
        ...(children ? { children } : {}),
        ...(alternate ? { alternate } : {})
      };
    };

    if (ts.isBlock(functionNode.body)) {
      for (const statement of functionNode.body.statements) {
        if (cancellation?.isCancellationRequested) break;
        statements.push(toStatement(statement));
      }
    } else {
      statements.push({
        id: `${request.uri}:${functionNode.body.getStart(file)}`,
        kind: 'return',
        label: functionNode.body.getText(file).slice(0, 160),
        location: span(file, request.uri, functionNode.body)
      });
    }
    return { function: symbol, statements, diagnostics: [] };
  }

  async resolveCall(request: AnalysisRequest, callSite: SourceSpan): Promise<CallResolution> {
    if (callSite.uri !== request.uri) {
      return { callSite, targets: [], reason: 'not-found' };
    }

    const file = sourceFile(request);
    const offset = file.getPositionOfLineAndCharacter(
      callSite.start.line,
      callSite.start.character
    );
    let call: ts.CallExpression | undefined;

    const locate = (node: ts.Node): void => {
      if (node.getStart(file) > offset || node.getEnd() <= offset) return;
      if (ts.isCallExpression(node)) {
        const start = node.getStart(file);
        const end = node.getEnd();
        if (start === offset || (start <= offset && offset < end)) call = node;
      }
      ts.forEachChild(node, locate);
    };
    locate(file);
    if (!call) return { callSite, targets: [], reason: 'not-found' };
    const expression: ts.LeftHandSideExpression = call.expression;
    if (!ts.isIdentifier(expression)) return { callSite, targets: [], reason: 'dynamic' };

    const name = expression.text;
    // Refuse syntactic resolution when a containing function can shadow the name.
    let ancestor: ts.Node | undefined = expression.parent;
    while (ancestor && !ts.isSourceFile(ancestor)) {
      const functionScope = ancestor;
      if (isFunction(functionScope)) {
        if (
          functionScope.parameters.some(
            (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name
          )
        ) {
          return { callSite, targets: [], reason: 'ambiguous' };
        }
        if (functionScope.body) {
          let shadowed = false;
          const scan = (node: ts.Node): void => {
            if (node !== functionScope.body && isFunction(node)) return;
            if (
              ts.isVariableDeclaration(node) &&
              ts.isIdentifier(node.name) &&
              node.name.text === name
            ) {
              shadowed = true;
            }
            ts.forEachChild(node, scan);
          };
          scan(functionScope.body);
          if (shadowed) return { callSite, targets: [], reason: 'ambiguous' };
        }
      }
      ancestor = ancestor.parent;
    }
    const candidates: ts.FunctionLikeDeclaration[] = [];
    const collect = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) {
        candidates.push(node);
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        candidates.push(node.initializer);
      }
      ts.forEachChild(node, collect);
    };
    collect(file);

    // A syntactic match is not enough to resolve shadowing and imports safely.
    // Only resolve a uniquely named top-level declaration; other calls are ambiguous.
    const topLevel = candidates.filter((candidate) => {
      if (ts.isFunctionDeclaration(candidate)) return ts.isSourceFile(candidate.parent);
      const declaration = candidate.parent;
      return (
        ts.isVariableDeclaration(declaration) &&
        ts.isVariableDeclarationList(declaration.parent) &&
        ts.isVariableStatement(declaration.parent.parent) &&
        ts.isSourceFile(declaration.parent.parent.parent)
      );
    });
    if (topLevel.length !== 1 || candidates.length !== 1) {
      return { callSite, targets: [], reason: candidates.length === 0 ? 'not-found' : 'ambiguous' };
    }
    const target = topLevel[0]!;
    return {
      callSite,
      targets: [
        {
          symbolId: `${request.uri}#${target.getStart(file)}`,
          definition: span(file, request.uri, target)
        }
      ]
    };
  }
}
