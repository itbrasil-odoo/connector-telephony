# Copyright 2025 Dixmit
# License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).

from odoo import api, fields, models
from odoo.exceptions import AccessError

VOIP_CREDENTIAL_FIELDS = {
    "voip_pbx_id",
    "voip_username",
    "voip_password",
    "voip_password_input",
}


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

    voip_credentials_locked = fields.Boolean(
        compute="_compute_voip_credentials_locked",
        help="Technical field: the PBX of this user does not let them edit "
        "the credentials and the current user is not an administrator.",
    )

    def _voip_is_admin(self):
        return self.env.su or self.env.user.has_group("base.group_system")

    @api.depends("voip_pbx_id.users_can_edit_credentials")
    @api.depends_context("uid")
    def _compute_voip_credentials_locked(self):
        is_admin = self._voip_is_admin()
        for user in self:
            # ``_origin``: the lock follows the saved PBX, not the one being
            # picked in a form.
            pbx = user._origin.sudo().voip_pbx_id
            user.voip_credentials_locked = bool(
                not is_admin and pbx and not pbx.users_can_edit_credentials
            )

    def _check_voip_credentials_lock(self, new_pbx_id=None):
        """Raise if a non administrator edits locked credentials.

        A user is locked when it has a PBX that does not allow users to edit
        credentials. Users without PBX are free to configure themselves.
        """
        if self._voip_is_admin():
            return
        pbx_model = self.env["voip.pbx"].sudo()
        pbxs = self.sudo().voip_pbx_id | pbx_model.browse(new_pbx_id or [])
        if pbxs.filtered(lambda p: not p.users_can_edit_credentials):
            raise AccessError(
                self.env._(
                    "The PBX credentials can only be changed by an administrator."
                )
            )

    def write(self, vals):
        if VOIP_CREDENTIAL_FIELDS & vals.keys():
            self._check_voip_credentials_lock(vals.get("voip_pbx_id"))
        return super().write(vals)

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if VOIP_CREDENTIAL_FIELDS & vals.keys():
                self.browse()._check_voip_credentials_lock(vals.get("voip_pbx_id"))
        return super().create(vals_list)

    def _compute_voip_password_input(self):
        for user in self:
            user.voip_password_input = False

    def _inverse_voip_password_input(self):
        self._check_voip_credentials_lock()
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
