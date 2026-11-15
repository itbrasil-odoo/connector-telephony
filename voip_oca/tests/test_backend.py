# Copyright 2025 Dixmit
# License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).

from odoo.exceptions import AccessError
from odoo.tests.common import TransactionCase


class TestVoipOca(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.pbx = cls.env["voip.pbx"].create(
            {
                "name": "Test PBX",
                "mode": "prod",
                "domain": "odoo-community.com",
                "ws_server": "wss://odoo-community.com",
            }
        )
        cls.partner_01 = cls.env["res.partner"].create(
            {
                "name": "Test Partner 01",
                "phone": "1234567890",
            }
        )
        cls.partner_02 = cls.env["res.partner"].create(
            {
                "name": "Test Partner 01",
                "phone": "0987654321",
            }
        )
        cls.activity_type = cls.env["mail.activity.type"].create(
            {
                "name": "Call",
                "category": "phonecall",
            }
        )
        cls.activity_01 = cls.env["mail.activity"].create(
            {
                "summary": "Activity 01",
                "activity_type_id": cls.activity_type.id,
                "res_id": cls.partner_01.id,
                "res_model_id": cls.env.ref("base.model_res_partner").id,
                "date_deadline": "2020-01-01",
                "user_id": cls.env.uid,
            }
        )
        cls.activity_02 = cls.env["mail.activity"].create(
            {
                "summary": "Activity 02",
                "activity_type_id": cls.activity_type.id,
                "res_id": cls.partner_02.id,
                "res_model_id": cls.env.ref("base.model_res_partner").id,
                "date_deadline": "2020-01-01",
                "user_id": cls.env.uid,
            }
        )
        cls.call_01 = cls.env["voip.call"].create(
            {
                "phone_number": "Call 01",
                "partner_id": cls.partner_01.id,
                "type_call": "incoming",
                "state": "ongoing",
                "pbx_id": cls.pbx.id,
                "start_date": "2020-01-01 00:00:00",
            }
        )
        cls.call_02 = cls.env["voip.call"].create(
            {
                "phone_number": "Call 02",
                "type_call": "outgoing",
                "state": "terminated",
                "pbx_id": cls.pbx.id,
                "start_date": "2020-01-01 00:00:00",
                "end_date": "2020-01-01 00:01:20",
            }
        )

    def test_partner_search(self):
        results = self.env["res.partner"].voip_get_contacts("1234567890", 0, 1000)
        self.assertIn(
            self.partner_01.id, [result["id"] for result in results["res.partner"]]
        )
        self.assertNotIn(
            self.partner_02.id, [result["id"] for result in results["res.partner"]]
        )
        results = self.env["res.partner"].voip_get_contacts("0987654321", 0, 1000)
        self.assertNotIn(
            self.partner_01.id, [result["id"] for result in results["res.partner"]]
        )
        self.assertIn(
            self.partner_02.id, [result["id"] for result in results["res.partner"]]
        )

    def test_activity_partner(self):
        self.assertEqual(self.activity_01.main_partner_id, self.partner_01)
        self.assertEqual(self.activity_01.main_partner, self.partner_01.name)
        self.assertEqual(self.activity_02.main_partner_id, self.partner_02)
        self.assertEqual(self.activity_02.main_partner, self.partner_02.name)

    def test_activity_search(self):
        results = self.env["mail.activity"].get_call_activities("Activity 01", 0, 1000)[
            "mail.activity"
        ]
        self.assertIn(self.activity_01.id, [result["id"] for result in results])
        self.assertNotIn(self.activity_02.id, [result["id"] for result in results])
        results = self.env["mail.activity"].get_call_activities("Activity 02", 0, 1000)[
            "mail.activity"
        ]
        self.assertNotIn(self.activity_01.id, [result["id"] for result in results])
        self.assertIn(self.activity_02.id, [result["id"] for result in results])

    def test_call_search(self):
        results = self.env["voip.call"].get_recent_calls("Call 01", 0, 1000)
        self.assertIn(self.call_01.id, [result["id"] for result in results])
        self.assertNotIn(self.call_02.id, [result["id"] for result in results])
        results = self.env["voip.call"].get_recent_calls("Call 02", 0, 1000)
        self.assertNotIn(self.call_01.id, [result["id"] for result in results])
        self.assertIn(self.call_02.id, [result["id"] for result in results])

    def test_call_process_ok(self):
        call_data = self.env["voip.call"].create_call(
            {
                "phone_number": "1234567890",
                "type_call": "incoming",
                "pbx_id": self.pbx.id,
            }
        )
        call = self.env["voip.call"].browse(call_data["id"])
        self.assertEqual(call.partner_id, self.partner_01)
        self.assertEqual(call.state, "calling")
        self.assertFalse(call.start_date)
        self.assertFalse(call.end_date)
        call.accept_call()
        self.assertEqual(call.state, "ongoing")
        self.assertTrue(call.start_date)
        self.assertFalse(call.end_date)
        call.terminate_call()
        self.assertEqual(call.state, "terminated")
        self.assertTrue(call.end_date)

    def test_call_process_rejected(self):
        call_data = self.env["voip.call"].create_call(
            {
                "phone_number": "1234567890",
                "type_call": "incoming",
                "pbx_id": self.pbx.id,
            }
        )
        call = self.env["voip.call"].browse(call_data["id"])
        self.assertEqual(call.partner_id, self.partner_01)
        self.assertEqual(call.state, "calling")
        self.assertFalse(call.start_date)
        self.assertFalse(call.end_date)
        call.reject_call()
        self.assertEqual(call.state, "rejected")
        self.assertTrue(call.end_date)
        self.assertFalse(call.start_date)


class TestVoipPassword(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.pbx = cls.env["voip.pbx"].create({"name": "PBX"})
        group = cls.env.ref("base.group_user")
        cls.alice, cls.bob = cls.env["res.users"].create(
            [
                {
                    "name": name,
                    "login": name.lower(),
                    "group_ids": [(6, 0, [group.id])],
                }
                for name in ("Alice", "Bob")
            ]
        )
        cls.alice.write(
            {
                "voip_pbx_id": cls.pbx.id,
                "voip_username": "1001",
                "voip_password": "SECRET1",
            }
        )

    def test_other_user_cannot_read_password(self):
        bob = self.bob
        with self.assertRaises(AccessError):
            self.alice.with_user(bob).read(["voip_password"])
        with self.assertRaises(AccessError):
            self.alice.with_user(bob).web_read({"voip_password": {}})
        with self.assertRaises(AccessError):
            self.env["res.users"].with_user(bob).search_read(
                [("id", "=", self.alice.id)], ["voip_password"]
            )
        with self.assertRaises(AccessError):
            self.env["res.users"].with_user(bob).formatted_read_group(
                [], groupby=["voip_password"], aggregates=["__count"]
            )
        with self.assertRaises(AccessError):
            self.env["res.users"].with_user(bob).search(
                [("voip_password", "=like", "SEC%")]
            )

    def test_own_password_input_is_write_only(self):
        alice = self.alice.with_user(self.alice)
        alice.write({"voip_password_input": "NEW"})
        self.assertEqual(self.alice.voip_password, "NEW")
        self.assertFalse(alice.read(["voip_password_input"])[0]["voip_password_input"])
        self.assertEqual(alice._voip_get_info()["pbx_password"], "NEW")

    def test_copy_does_not_carry_credentials(self):
        copy = self.alice.copy({"login": "alice2"})
        self.assertFalse(copy.voip_password)
        self.assertFalse(copy.voip_username)


class TestVoipCredentials(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.pbx = cls.env["voip.pbx"].create({"name": "Default PBX"})
        cls.locked_pbx = cls.env["voip.pbx"].create(
            {"name": "Locked PBX", "users_can_edit_credentials": False}
        )
        cls.user = cls.env["res.users"].create(
            {
                "name": "Voip User",
                "login": "voip_user",
                "group_ids": [(6, 0, [cls.env.ref("base.group_user").id])],
            }
        )
        cls.admin = cls.env["res.users"].create(
            {
                "name": "Voip Admin",
                "login": "voip_admin",
                "group_ids": [(6, 0, [cls.env.ref("base.group_system").id])],
            }
        )

    def _lock_user(self):
        self.user.write(
            {
                "voip_pbx_id": self.locked_pbx.id,
                "voip_username": "1001",
                "voip_password": "admin-secret",
            }
        )
        return self.user.with_user(self.user)

    def test_user_cannot_edit_own_credentials_when_disabled(self):
        me = self._lock_user()
        for vals in (
            {"voip_password_input": "mine"},
            {"voip_username": "2000"},
            {"voip_pbx_id": self.pbx.id},
        ):
            with self.assertRaises(AccessError):
                me.write(vals)
        self.assertEqual(self.user.voip_password, "admin-secret")
        self.assertEqual(self.user.voip_pbx_id, self.locked_pbx)
        self.assertTrue(me.voip_credentials_locked)

    def test_user_can_edit_own_credentials_by_default(self):
        self.user.voip_pbx_id = self.pbx
        me = self.user.with_user(self.user)
        me.write({"voip_username": "1001", "voip_password_input": "mine"})
        self.assertEqual(self.user.voip_password, "mine")
        self.assertFalse(me.voip_credentials_locked)

    def test_user_without_pbx_can_configure_themselves(self):
        self.assertFalse(self.user.voip_pbx_id)
        me = self.user.with_user(self.user)
        self.assertFalse(me.voip_credentials_locked)
        me.write(
            {
                "voip_pbx_id": self.pbx.id,
                "voip_username": "1001",
                "voip_password_input": "mine",
            }
        )
        self.assertEqual(self.user.voip_password, "mine")

    def test_user_cannot_move_to_locked_pbx(self):
        self.user.voip_pbx_id = self.pbx
        with self.assertRaises(AccessError):
            self.user.with_user(self.user).write({"voip_pbx_id": self.locked_pbx.id})
        self.assertEqual(self.user.voip_pbx_id, self.pbx)

    def test_user_without_pbx_cannot_pick_locked_pbx(self):
        with self.assertRaises(AccessError):
            self.user.with_user(self.user).write({"voip_pbx_id": self.locked_pbx.id})

    def test_non_admin_cannot_create_user_with_locked_pbx(self):
        manager = self.env["res.users"].create(
            {
                "name": "Manager",
                "login": "voip_manager",
                "group_ids": [(6, 0, [self.env.ref("base.group_erp_manager").id])],
            }
        )
        with self.assertRaises(AccessError):
            self.env["res.users"].with_user(manager).create(
                {
                    "name": "New",
                    "login": "voip_new",
                    "voip_pbx_id": self.locked_pbx.id,
                }
            )

    def test_admin_can_edit_and_read_with_lock(self):
        self._lock_user()
        admin_user = self.user.with_user(self.admin)
        admin_user.write({"voip_username": "2000", "voip_password": "new-secret"})
        self.assertEqual(admin_user.voip_password, "new-secret")
        data = admin_user.read(["voip_password"])[0]
        self.assertEqual(data["voip_password"], "new-secret")
        self.assertFalse(admin_user.voip_credentials_locked)

    def test_softphone_still_gets_password(self):
        me = self._lock_user()
        self.assertEqual(me._voip_get_info()["pbx_password"], "admin-secret")


class TestVoipFieldLabels(TransactionCase):
    def test_voip_fields_have_distinct_labels(self):
        fields_ = self.env["res.users"]._fields
        labels = {}
        for name, field in fields_.items():
            labels.setdefault(field.string, []).append(name)
        for name in fields_:
            if name.startswith("voip_"):
                self.assertEqual(
                    labels[fields_[name].string],
                    [name],
                    f"{name} shares its label with another res.users field",
                )
