import unittest

import server


class DistributionListRulesTest(unittest.TestCase):
    def setUp(self):
        self.gateway = server.DemoGateway()
        self.avery = self.gateway.people[0]
        self.jordan = self.gateway.people[1]

    def test_non_owner_cannot_edit_or_add_members(self):
        group = 'design-community@slalom.com'
        for op, payload in (
            ('update', {'displayName': 'Changed'}),
            ('add_member', {'email': self.avery['email']}),
            ('add_owner', {'email': self.avery['email']}),
        ):
            with self.subTest(op=op), self.assertRaises(server.ApiError) as caught:
                self.gateway.call(op, self.avery, {'id': group, **payload})
            self.assertEqual(caught.exception.status, 403)

    def test_approval_does_not_add_member_until_owner_decides(self):
        group = 'design-community@slalom.com'
        response = self.gateway.call('membership', self.avery, {'id': group, 'action': 'join'})
        self.assertTrue(response['approvalRequired'])
        self.assertFalse(self.gateway.call('get', self.avery, {'id': group})['isMember'])
        store = server.Store(':memory:')
        first = store.request(group, self.avery)
        self.assertEqual(first, store.request(group, self.avery))
        self.gateway.call('approve_request', self.jordan, {'id': group, 'email': self.avery['email']})
        store.decide(first, self.jordan, 'approved')
        self.assertTrue(self.gateway.call('get', self.avery, {'id': group})['isMember'])
        self.assertFalse(store.requests_for({group}))

    def test_closed_list_rejects_self_join(self):
        with self.assertRaises(server.ApiError) as caught:
            self.gateway.call('membership', self.jordan, {'id': 'tech-support-leads@slalom.com', 'action': 'join'})
        self.assertEqual(caught.exception.status, 403)

    def test_coowner_addition_preserves_existing_owner(self):
        group = 'chicago-book-club@slalom.com'
        self.gateway.call('update', self.avery, {'id': group, 'coOwner': 'sofia.ramirez@slalom.com'})
        owners = self.gateway.call('get', self.avery, {'id': group})['owners']
        self.assertEqual(owners, ['avery.morgan@slalom.com', 'sofia.ramirez@slalom.com'])

    def test_add_multiple_owners_and_reject_duplicate(self):
        group = 'chicago-book-club@slalom.com'
        self.gateway.call('add_owner', self.avery, {'id': group, 'email': 'sofia.ramirez@slalom.com'})
        self.gateway.call('add_owner', self.avery, {'id': group, 'email': 'taylor.brooks@slalom.com'})
        owners = self.gateway.call('get', self.avery, {'id': group})['owners']
        self.assertEqual(owners, [self.avery['email'], 'sofia.ramirez@slalom.com', 'taylor.brooks@slalom.com'])
        with self.assertRaises(server.ApiError) as caught:
            self.gateway.call('add_owner', self.avery, {'id': group, 'email': 'sofia.ramirez@slalom.com'})
        self.assertEqual(caught.exception.status, 409)

    def test_join_and_leave_spaces_have_separate_memberships(self):
        joined = {g['id'] for g in self.gateway.call('joined', self.avery, {})}
        discover = {g['id'] for g in self.gateway.call('discover', self.avery, {'q': ''})}
        self.assertEqual(joined, {'tech-support-leads@slalom.com', 'chicago-events@slalom.com'})
        self.assertEqual(discover, {'atl-lunch-learn@slalom.com', 'design-community@slalom.com'})
        self.assertFalse(joined & discover)

    def test_activity_only_returns_signed_in_users_actions(self):
        store = server.Store(':memory:')
        group = 'chicago-book-club@slalom.com'
        store.audit(group, self.jordan, 'joined', self.jordan['email'])
        store.audit(group, self.avery, 'owner added', 'sofia.ramirez@slalom.com')
        activity = store.activities(self.avery['oid'])
        self.assertEqual([row['action'] for row in activity], ['owner added'])
        self.assertTrue(all(row['actor_oid'] == self.avery['oid'] for row in activity))

    def test_create_rejects_taken_alias(self):
        payload = {'alias': 'chicago-book-club', 'displayName': 'A duplicate', 'senderPolicy': 'internal',
                   'senders': [], 'visible': True, 'joinPolicy': 'approval', 'coOwner': None, 'members': []}
        with self.assertRaises(server.ApiError) as caught:
            self.gateway.call('create', self.avery, payload)
        self.assertEqual(caught.exception.status, 409)

    def test_settings_validation(self):
        with self.assertRaises(server.ApiError):
            server.settings_from({'senderPolicy': 'specific', 'senders': []})
        with self.assertRaises(server.ApiError):
            server.settings_from({'visible': 'yes'})


if __name__ == '__main__':
    unittest.main()
