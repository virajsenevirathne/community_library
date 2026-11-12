-- A demo library for local development: npm run demo-data -w @community-library/web
-- Sign in with admin@demo.test (or parent@demo.test); the code is printed in
-- the terminal running npm run dev. Safe to run again: existing rows are kept.
insert or ignore into users (id, name, email, email_verified, updated_at) values
  ('demo-admin', 'Alex', 'admin@demo.test', 1, 0),
  ('demo-parent', 'Priya', 'parent@demo.test', 1, 0),
  ('demo-parent-2', 'Tom', 'tom@demo.test', 1, 0);
-- The demo admin runs the site too, unless someone already does.
insert into platform_admins (user_id) select 'demo-admin' where not exists (select 1 from platform_admins);
insert or ignore into libraries (id, name, slug, settings, terms_accepted_at) values
  ('demo-lib', 'Demo Owls', 'demo-owls',
   '{"timezone":"Australia/Sydney","closedWeekdays":[0,6],"theme":"teal"}', 1);
insert or ignore into families (id, library_id, name, status) values
  ('demo-lee', 'demo-lib', 'Lee', 'active'),
  ('demo-okafor', 'demo-lib', 'Okafor', 'active'),
  ('demo-nguyen', 'demo-lib', 'Nguyen', 'pending');
insert or ignore into memberships (id, library_id, user_id, role, family_id) values
  ('demo-m-admin', 'demo-lib', 'demo-admin', 'admin', null),
  ('demo-m-priya', 'demo-lib', 'demo-parent', 'member', 'demo-lee'),
  ('demo-m-tom', 'demo-lib', 'demo-parent-2', 'member', 'demo-okafor');
insert or ignore into titles (id, library_id, title, authors, isbn) values
  ('demo-t1', 'demo-lib', 'Owl Babies', 'Martin Waddell', '9780744531679'),
  ('demo-t2', 'demo-lib', 'The Gruffalo', 'Julia Donaldson', '9780333710937'),
  ('demo-t3', 'demo-lib', 'Where the Wild Things Are', 'Maurice Sendak', '9780099408390'),
  ('demo-t4', 'demo-lib', 'The Very Hungry Caterpillar', 'Eric Carle', '9780241003008'),
  ('demo-t5', 'demo-lib', 'Possum Magic', 'Mem Fox', '9781742990040'),
  ('demo-t6', 'demo-lib', 'Hairy Maclary from Donaldson''s Dairy', 'Lynley Dodd', '9780140505313');
insert or ignore into copies (id, library_id, title_id, short_code, label_printed_at) values
  ('demo-c1', 'demo-lib', 'demo-t1', 'DM2A', 1),
  ('demo-c2', 'demo-lib', 'demo-t2', 'DM3A', 1),
  ('demo-c3', 'demo-lib', 'demo-t3', 'DM4A', 1),
  ('demo-c4', 'demo-lib', 'demo-t4', 'DM5A', 1),
  ('demo-c5', 'demo-lib', 'demo-t5', 'DM6A', null),
  ('demo-c6', 'demo-lib', 'demo-t6', 'DM7A', null);
-- The Lee family has one book out, due a week ago.
insert or ignore into loans (id, library_id, copy_id, family_id, borrowed_by, borrowed_at, due_on) values
  ('demo-loan-1', 'demo-lib', 'demo-c2', 'demo-lee', 'demo-parent',
   (unixepoch('now', '-21 days') * 1000), date('now', '-7 days'));
