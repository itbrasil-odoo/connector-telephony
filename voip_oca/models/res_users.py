# Copyright 2025 Dixmit
# License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).

from odoo import fields, models


class ResUsers(models.Model):
    _inherit = "res.users"

    # ``user_writeable`` replaces the SELF_WRITEABLE_FIELDS list, which Odoo 20
    # no longer reads.
    voip_pbx_id = fields.Many2one("voip.pbx", user_writeable=True)
    voip_username = fields.Char(user_writeable=True, copy=False)
    # Only administrators can read the stored password, so colleagues cannot
    # read, search, group or export it. Users reset their own password through
    # ``voip_password_input``.
    voip_password = fields.Char(groups="base.group_system", copy=False)
    voip_password_input = fields.Char(
        string="Password",
        compute="_compute_voip_password_input",
        inverse="_inverse_voip_password_input",
        user_writeable=True,
        help="Write-only: it always reads empty.",
    )

    def _compute_voip_password_input(self):
        for user in self:
            user.voip_password_input = False

    def _inverse_voip_password_input(self):
        for user in self:
            if user.voip_password_input:
                user.sudo().voip_password = user.voip_password_input
        # never keep the written value in the cache: the field reads empty
        self.invalidate_recordset(["voip_password_input"])

    def _voip_get_info(self):
        # sudo: the softphone needs the password, which users cannot read.
        user = self.sudo()
        return {
            "pbx_id": user.voip_pbx_id.id,
            "pbx": user.voip_pbx_id.name,
            "pbx_domain": user.voip_pbx_id.domain,
            "pbx_ws": user.voip_pbx_id.ws_server,
            "mode": (
                user.voip_username and user.voip_password and user.voip_pbx_id.mode
            )
            or "test",
            "pbx_username": user.voip_username,
            "pbx_password": user.voip_password,
            "tones": {
                "dialtone": "/voip_oca/static/audio/dialtone.mp3",
                "calltone": "/voip_oca/static/audio/calltone.mp3",
                "ringbacktone": "/voip_oca/static/audio/ringbacktone.mp3",
            },
        }
