const vscode = require('vscode');

module.exports = class Resolver {
    async importCommand(selection) {
        let resolving = this.resolving(selection);

        if (resolving === null) {
            this.showMessage(`$(issue-opened)  No class is selected.`, true);
            return;
        }

        let files = await this.findFiles();
        let namespaces = await this.findNamespaces(resolving, files);
        let fqcn = await this.pickClass(namespaces);

        this.importClass(fqcn, resolving);
    }

    importClass(fqcn, resolving) {
        let useStatements, declarationLines;

        [useStatements, declarationLines] = this.getDeclarations(fqcn);

        if (this.hasConflict(useStatements, resolving)) {
            this.insertAsAlias(fqcn, useStatements, declarationLines);
        } else {
            this.insert(fqcn, declarationLines);
        }
    }

    async insert(pickedClass, declarationLines, alias = null) {
        let [prepend, append, insertLine] = this.getInsertLine(declarationLines);

        this.activeEditor().edit(textEdit => {
            textEdit.replace(
                new vscode.Position((insertLine), 0),
                (`${prepend}use ${pickedClass}`) + (alias !== null ? ` as ${alias}` : '') + (`;${append}`)
            );
        });

        if (this.config('autoSort')) {
            await this.activeEditor().document.save();

            this.sortImports();
        }

        this.showMessage('$(check)  Class imported.');
    }

    insertAsAlias(fqcn, useStatements, declarationLines) {
        vscode.window.showInputBox({
            placeHolder: 'Enter an alias'
        }).then(alias => {
            if (this.hasConflict(useStatements, alias)) {
                vscode.window.setStatusBarMessage(`$(issue-opened)  This alias is already in use.`, 3000)

                this.insertAsAlias(fqcn, useStatements, declarationLines)
            } else if (alias !== undefined && alias !== '') {
                this.insert(fqcn, declarationLines, alias);
            }
        });
    }

    async expandCommand(selection) {
        let resolving = this.resolving(selection);

        if (resolving === null) {
            this.showMessage(`$(issue-opened)  No class is selected.`, true);
            return;
        }

        let files = await this.findFiles();
        let namespaces = await this.findNamespaces(resolving, files);
        let fqcn = await this.pickClass(namespaces);

        this.expandClass(selection, fqcn);
    }

    expandClass(selection, fqcn) {
        this.activeEditor().edit(textEdit => {
            textEdit.replace(
                this.activeEditor().document.getWordRangeAtPosition(selection.active),
                (this.config('leadingSeparator') ? '\\' : '') + fqcn
            );
        });
    }

    sortCommand() {
        this.sortImports();

        this.showMessage('$(check)  Imports sorted.');
    }

    findFiles() {
        return vscode.workspace.findFiles('**/*.php', this.config('exclude'));
    }

    findNamespaces(resolving, files) {
        return new Promise((resolve, reject) => {
            let textDocuments = this.getTextDocuments(files, resolving);

            Promise.all(textDocuments).then(docs => {
                let parsedNamespaces = this.parseNamespaces(docs, resolving);

                if (parsedNamespaces.length === 0) {
                    parsedNamespaces.push(resolving);
                }

                resolve(parsedNamespaces);
            });
        });
    }

    pickClass(namespaces) {
        return new Promise((resolve, reject) => {
            if (namespaces.length === 1) {
                // only one namespace found so no need to show picker.
                return resolve(namespaces[0]);
            }

            vscode.window.showQuickPick(namespaces).then(picked => {
                if (picked !== undefined) {
                    resolve(picked);
                }
            });
        })
    }

    getTextDocuments(files, resolving) {
        let textDocuments = [];

        for (let i = 0; i < files.length; i++) {
            let fileName = files[i].fsPath.replace(/^.*[\\\/]/, '').split('.')[0];

            if (fileName !== resolving) {
                continue;
            }

            textDocuments.push(vscode.workspace.openTextDocument(files[i]));
        }

        return textDocuments;
    }

    parseNamespaces(docs, resolving) {
        let parsedNamespaces = [];

        for (let i = 0; i < docs.length; i++) {
            for (let line = 0; line < docs[i].lineCount; line++) {
                let textLine = docs[i].lineAt(line).text;

                if (textLine.startsWith('namespace ') || textLine.startsWith('<?php namespace ')) {
                    let fqcn = textLine.match(/^namespace\s+(.+)?;/).pop() + resolving;

                    if (parsedNamespaces.indexOf(fqcn) === -1) {
                        parsedNamespaces.push(fqcn);
                        break;
                    }
                }
            }
        }

        return parsedNamespaces;
    }

    sortImports() {
        let useStatements = this.getDeclarations();

        if (useStatements.length <= 1) {
            this.showMessage('$(issue-opened)  Nothing to sort.', true);
            return;
        }

        let sorted = useStatements.slice().sort((a, b) => {
            if (this.config('sortAlphabetically')) {
                if (a.text.toLowerCase() < b.text.toLowerCase()) return -1;
                if (a.text.toLowerCase() > b.text.toLowerCase()) return 1;
                return 0;
            } else {
                return a.text.length - b.text.length;
            }
        });

        this.activeEditor().edit(textEdit => {
            for (let i = 0; i < sorted.length; i++) {
                textEdit.replace(
                    new vscode.Range(useStatements[i].line, 0, useStatements[i].line, useStatements[i].text.length),
                    sorted[i].text
                );
            }
        });
    }

    hasConflict(useStatements, resolving) {
        for (let i = 0; i < useStatements.length; i++) {
            if (useStatements[i].text.endsWith(`${resolving};`)) {
                return true;
            }
        }

        return false;
    }

    getDeclarations(pickedClass = null) {
        let useStatements = [];
        let declarationLines = {
            PHPTag: 0,
            namespace: null,
            useStatement: null,
            class: null
        };

        for (let line = 0; line < this.activeEditor().document.lineCount; line++) {
            let text = this.activeEditor().document.lineAt(line).text;

            if (pickedClass !== null && text === `use ${pickedClass};`) {
                this.showMessage('$(issue-opened)  Class already imported.', true);
                return;
            }

            // break if all declarations were found.
            if (declarationLines.PHPTag && declarationLines.namespace &&
                declarationLines.useStatement && declarationLines.class) {
                break;
            }

            if (text.startsWith('<?php')) {
                declarationLines.PHPTag = line + 1;
            } else if (text.startsWith('namespace ') || text.startsWith('<?php namespace')) {
                declarationLines.namespace = line + 1;
            } else if (text.startsWith('use ')) {
                useStatements.push({ text, line });
                declarationLines.useStatement = line + 1;
            } else if (/(class|trait|interface)\s+\w+/.test(text)) {
                declarationLines.class = line + 1;
            } else {
                continue;
            }
        }

        if (pickedClass === null) {
            return useStatements;
        }

        return [useStatements, declarationLines];
    }

    getInsertLine(declarationLines) {
        let prepend = declarationLines.PHPTag === 0 ? '' : '\n';
        let append = '\n';
        let insertLine = declarationLines.PHPTag;

        if (prepend === '' && declarationLines.namespace !== null) {
            prepend = '\n';
        }

        if (declarationLines.useStatement !== null) {
            prepend = '';
            insertLine = declarationLines.useStatement;
        } else if (declarationLines.namespace !== null) {
            insertLine = declarationLines.namespace;
        }

        if (declarationLines.class !== null &&
            ((declarationLines.class - declarationLines.useStatement) <= 1 ||
            (declarationLines.class - declarationLines.namespace) <= 1 ||
            (declarationLines.class - declarationLines.PHPTag) <= 1)
        ) {
            append = '\n\n';
        }

        return [prepend, append, insertLine];
    }

    activeEditor() {
        return vscode.window.activeTextEditor;
    }

    resolving(selection) {
        let wordRange = this.activeEditor().document.getWordRangeAtPosition(selection.active);

        if (wordRange === undefined) {
            return null;
        }

        return this.activeEditor().document.getText(wordRange);
    }

    config(key) {
        return vscode.workspace.getConfiguration('namespaceResolver').get(key);
    }

    showMessage(message, error = false) {
        if (this.config('showMessageOnStatusBar')) {
            vscode.window.setStatusBarMessage(message, 3000);
            return;
        }

        message = message.replace(/\$\(.+?\)\s\s/, '');

        if (error) {
            vscode.window.showErrorMessage(message);
        } else {
            vscode.window.showInformationMessage(message);
        }
    }
}