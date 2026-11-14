# Copyright 2025 Dixmit
# License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).
import odoo

from odoo.addons.web.tests.test_js import WebSuite


@odoo.tests.tagged("post_install", "-at_install")
class TestAutomationOCA(WebSuite):
    """Test Automation OCA"""

    @odoo.tests.no_retry
    def test_voip_oca(self, modules):
        # WebSuite is a CrossModule test in 20.0: the selected modules are
        # passed to the test method. Only run the hoot tests of this module.
        self.test_unit_desktop(["voip_oca"])
