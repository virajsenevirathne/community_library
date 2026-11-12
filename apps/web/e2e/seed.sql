-- Test data for the browser tests: one library with an admin, a family and two books.
insert into users (id, name, email, email_verified, updated_at) values
  ('e2e-owner', 'Owen', 'owner@e2e.test', 1, 0),
  ('e2e-admin', 'Alex', 'admin@e2e.test', 1, 0),
  ('e2e-parent', 'Priya', 'parent@e2e.test', 1, 0),
  ('e2e-other', 'Sam', 'other@e2e.test', 1, 0);
insert into platform_admins (user_id) values ('e2e-owner');
insert into libraries (id, name, slug, settings, terms_accepted_at) values
  ('e2e-lib', 'E2E Owls', 'e2e-owls', '{"closedWeekdays":[],"timezone":"Australia/Sydney"}', 1);
insert into families (id, library_id, name, status) values
  ('e2e-family', 'e2e-lib', 'Lee', 'active'),
  ('e2e-family-2', 'e2e-lib', 'Okafor', 'active');
insert into memberships (id, library_id, user_id, role, family_id) values
  ('e2e-m-admin', 'e2e-lib', 'e2e-admin', 'admin', null),
  ('e2e-m-parent', 'e2e-lib', 'e2e-parent', 'member', 'e2e-family'),
  ('e2e-m-other', 'e2e-lib', 'e2e-other', 'member', 'e2e-family-2');
insert into titles (id, library_id, title, authors) values
  ('e2e-t1', 'e2e-lib', 'Owl Babies', 'Martin Waddell'),
  ('e2e-t2', 'e2e-lib', 'The Gruffalo', 'Julia Donaldson'),
  ('e2e-t3', 'e2e-lib', 'Where the Wild Things Are', 'Maurice Sendak');
insert into copies (id, library_id, title_id, short_code, label_printed_at) values
  ('e2e-c1', 'e2e-lib', 'e2e-t1', 'BK2A', 1),
  ('e2e-c2', 'e2e-lib', 'e2e-t2', 'BK3A', 1),
  ('e2e-c3', 'e2e-lib', 'e2e-t3', 'BK4A', 1);
