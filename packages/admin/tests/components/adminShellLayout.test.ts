import { describe, expect, it } from "vitest";

import {
	ADMIN_SHELL_BACKGROUND_CLASS,
	ADMIN_SHELL_HEADER_HEIGHT,
	ADMIN_SHELL_SIDEBAR_ICON_WIDTH,
} from "../../src/components/adminShellLayout";

describe("admin shell layout constants", () => {
	it("keeps the collapsed sidebar square with the header", () => {
		expect(ADMIN_SHELL_HEADER_HEIGHT).toBe("58px");
		expect(ADMIN_SHELL_SIDEBAR_ICON_WIDTH).toBe(ADMIN_SHELL_HEADER_HEIGHT);
	});

	it("uses one shell background token across sidebar and content", () => {
		expect(ADMIN_SHELL_BACKGROUND_CLASS).toBe("bg-kumo-elevated");
	});
});
