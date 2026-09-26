import io
import json
import unittest
import urllib.error

from indra.app import Inventory, InventoryError, MattermostAPI, interactive, role_values


ROLE = {"id": "field-1", "name": "Role", "type": "multiselect", "attrs": {"options": [
    {"id": "lead", "name": "Team Lead"}, {"id": "dev", "name": "Developer"}
]}}


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return io.BytesIO(json.dumps(self.payload).encode())

    def __exit__(self, *_):
        pass


class FakeOpener:
    def __init__(self, responses):
        self.responses = responses
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        path = request.full_url.split("/api/v4", 1)[1]
        result = self.responses[path]
        if isinstance(result, int):
            raise urllib.error.HTTPError(request.full_url, result, "denied", {}, None)
        return FakeResponse(result)


class MattermostTests(unittest.TestCase):
    def test_pagination_and_get_only(self):
        first = [{"id": str(i)} for i in range(100)]
        opener = FakeOpener({
            "/teams?page=0&per_page=100": first,
            "/teams?page=1&per_page=100": [{"id": "100"}],
        })
        api = MattermostAPI("https://example.org", "secret", opener)
        self.assertEqual(len(api.pages("/teams")), 101)
        self.assertEqual([req.get_method() for req in opener.requests], ["GET", "GET"])
        self.assertEqual(opener.requests[0].get_header("Authorization"), "Bearer secret")

    def test_nonadvancing_pagination_is_error(self):
        page = [{"id": str(i)} for i in range(100)]
        api = MattermostAPI("https://example.org", "secret", FakeOpener({
            "/bots?page=0&per_page=100": {"bots": page},
            "/bots?page=1&per_page=100": {"bots": page},
        }))
        with self.assertRaisesRegex(InventoryError, "did not advance"):
            api.pages("/bots", "bots")

    def test_permission_error_is_sanitized_and_incomplete(self):
        api = MattermostAPI("https://example.org", "secret", FakeOpener({"/bots": 403}))
        with self.assertRaisesRegex(InventoryError, "inventory may be incomplete") as raised:
            api.get("/bots")
        self.assertNotIn("secret", str(raised.exception))

    def test_roles_resolve_multiselect_and_array_shape(self):
        self.assertEqual(role_values({"field-1": ["lead", "dev"]}, ROLE), ["Team Lead", "Developer"])
        self.assertEqual(role_values([{"field_id": "field-1", "value": '["dev"]'}], ROLE), ["Developer"])

    def test_team_membership_intersection_preserves_multi_team_bots(self):
        responses = {
            "/bots?page=0&per_page=100": {"bots": [
                {"user_id": "a", "username": "alice", "display_name": "Alice"},
                {"user_id": "b", "username": "bob", "display_name": "Bob"},
                {"user_id": "c", "username": "charlie", "display_name": "Charlie", "delete_at": 1},
            ]},
            "/teams/one/members?page=0&per_page=100": [{"user_id": "a"}, {"user_id": "b"}, {"user_id": "c"}],
            "/teams/two/members?page=0&per_page=100": [{"user_id": "a"}],
            "/custom_profile_attributes/fields": [ROLE],
            "/users/a/custom_profile_attributes": {"field-1": ["lead", "dev"]},
            "/users/b/custom_profile_attributes": {"field-1": ["dev"]},
        }
        inventory = Inventory(MattermostAPI("https://example.org", "secret", FakeOpener(responses)))
        self.assertEqual([(seat.username, seat.roles) for seat in inventory.seats({"id": "one"})],
                         [("alice", ("Team Lead", "Developer")), ("bob", ("Developer",))])
        self.assertEqual([seat.username for seat in inventory.seats({"id": "two"})], ["alice"])

    def test_profile_failure_marks_row_not_empty_role(self):
        responses = {
            "/bots?page=0&per_page=100": {"bots": [{"user_id": "a", "username": "alice"}]},
            "/teams/one/members?page=0&per_page=100": [{"user_id": "a"}],
            "/custom_profile_attributes/fields": [ROLE],
            "/users/a/custom_profile_attributes": 403,
        }
        seat = Inventory(MattermostAPI("https://example.org", "secret", FakeOpener(responses))).seats({"id": "one"})[0]
        self.assertEqual(seat.roles, ())
        self.assertIn("incomplete", seat.role_error)

    def test_interactive_navigation_refresh_and_currentness(self):
        class StubInventory:
            def __init__(self):
                self.team_calls = 0
                self.seat_calls = 0

            def teams(self):
                self.team_calls += 1
                return [{"id": "one", "name": "yahaha", "display_name": "Yahaha"}]

            def seats(self, _team):
                self.seat_calls += 1
                return []

        stub = StubInventory()
        answers = iter(["1", "r", "b", "q"])
        output = []
        self.assertEqual(interactive(stub, lambda _prompt: next(answers), output.append), 0)
        self.assertEqual((stub.team_calls, stub.seat_calls), (2, 2))
        self.assertTrue(any("seats refreshed" in line for line in output))
        self.assertTrue(any("not connected yet" in line for line in output))


if __name__ == "__main__":
    unittest.main()
