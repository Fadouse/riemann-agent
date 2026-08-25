import assert from "node:assert";
import * as path from "node:path";
import { describe, it } from "node:test";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("TUI working directory reports", () => {
	it("reports the initial and changed directories, deduplicates, and reports again after resume", () => {
		const terminal = new VirtualTerminal();
		const tui = new TuiMainScreen(terminal);
		const initialDirectory = path.join(process.cwd(), "initial");
		const changedDirectory = path.join(process.cwd(), "changed");
		const stoppedDirectory = path.join(process.cwd(), "changed-while-stopped");

		try {
			tui.setWorkingDirectory(initialDirectory);
			assert.deepEqual(terminal.workingDirectoryReports, []);

			tui.start();
			assert.deepEqual(terminal.workingDirectoryReports, [initialDirectory]);

			tui.setWorkingDirectory(changedDirectory);
			tui.setWorkingDirectory(changedDirectory);
			assert.deepEqual(terminal.workingDirectoryReports, [initialDirectory, changedDirectory]);

			tui.stop({ preserveScreen: true });
			tui.setWorkingDirectory(stoppedDirectory);
			assert.deepEqual(terminal.workingDirectoryReports, [initialDirectory, changedDirectory]);

			tui.start();
			assert.deepEqual(terminal.workingDirectoryReports, [initialDirectory, changedDirectory, stoppedDirectory]);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});
});
