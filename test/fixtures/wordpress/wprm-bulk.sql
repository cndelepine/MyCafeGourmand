CREATE TABLE `wp_posts` (
  `ID` bigint NOT NULL,
  `post_type` varchar(32) NOT NULL,
  `post_status` varchar(20) NOT NULL,
  `post_parent` bigint NOT NULL,
  `post_name` varchar(200) NOT NULL,
  `post_title` text NOT NULL,
  `post_content` longtext NOT NULL,
  `post_excerpt` text NOT NULL,
  `post_date` datetime NOT NULL,
  `post_date_gmt` datetime NOT NULL,
  `post_modified` datetime NOT NULL,
  `post_modified_gmt` datetime NOT NULL,
  `post_password` varchar(255) NOT NULL,
  `post_mime_type` varchar(100) NOT NULL
);
CREATE TABLE `wp_postmeta` (
  `meta_id` bigint NOT NULL,
  `post_id` bigint NOT NULL,
  `meta_key` varchar(255) NOT NULL,
  `meta_value` longtext NULL
);
CREATE TABLE `wp_terms` (
  `term_id` bigint NOT NULL,
  `name` varchar(200) NOT NULL,
  `slug` varchar(200) NOT NULL
);
CREATE TABLE `wp_term_taxonomy` (
  `term_taxonomy_id` bigint NOT NULL,
  `term_id` bigint NOT NULL,
  `taxonomy` varchar(32) NOT NULL
);
CREATE TABLE `wp_term_relationships` (
  `object_id` bigint NOT NULL,
  `term_taxonomy_id` bigint NOT NULL
);
CREATE TABLE `wp_redirection_items` (
  `id` bigint NOT NULL,
  `url` text NOT NULL,
  `match_url` text NOT NULL,
  `regex` tinyint NOT NULL,
  `status` varchar(20) NOT NULL,
  `match_type` varchar(20) NOT NULL,
  `action_type` varchar(20) NOT NULL,
  `action_code` varchar(10) NOT NULL,
  `action_data` text NULL
);
CREATE TABLE `wp_options` (
  `option_id` bigint NOT NULL,
  `option_name` varchar(191) NOT NULL,
  `option_value` longtext NOT NULL
);

INSERT INTO `wp_options` (`option_id`, `option_name`, `option_value`) VALUES
  (1, 'home', 'https://example.test/'),
  (2, 'permalink_structure', '/%postname%/'),
  (3, 'polylang', 'a:5:{s:10:"force_lang";i:1;s:12:"hide_default";b:1;s:7:"rewrite";b:1;s:13:"redirect_lang";b:0;s:12:"default_lang";s:2:"en";}');

INSERT INTO `wp_posts`
  (`ID`, `post_type`, `post_status`, `post_parent`, `post_name`, `post_title`,
   `post_content`, `post_excerpt`, `post_date`, `post_date_gmt`, `post_modified`,
   `post_modified_gmt`, `post_password`, `post_mime_type`)
VALUES
  (1, 'page', 'publish', 0, 'editorial-ready', 'Editorial ready',
   'Editorial body', 'Editorial excerpt', '2026-08-01 10:00:00',
   '2026-08-01 17:00:00', '2026-08-02 10:00:00', '2026-08-02 17:00:00', '', ''),
  (2, 'page', 'publish', 0, 'editorial-fr', 'Editorial FR',
   'Editorial FR body', 'Editorial FR excerpt', '2026-08-01 10:00:00',
   '2026-08-01 17:00:00', '2026-08-02 10:00:00', '2026-08-02 17:00:00', '', ''),
  (3, 'page', 'publish', 0, 'group-en', 'Group EN',
   'Group EN body', '', '2026-08-01 10:00:00', '2026-08-01 17:00:00',
   '2026-08-02 10:00:00', '2026-08-02 17:00:00', '', ''),
  (4, 'page', 'publish', 0, 'group-fr', 'Group FR',
   'Group FR body', '', '2026-08-01 10:00:00', '2026-08-01 17:00:00',
   '2026-08-02 10:00:00', '2026-08-02 17:00:00', '', ''),
  (5, 'page', 'publish', 0, 'ungrouped-fr', 'Ungrouped FR',
   'Ungrouped FR body', '', '2026-08-01 10:00:00', '2026-08-01 17:00:00',
   '2026-08-02 10:00:00', '2026-08-02 17:00:00', '', ''),
  (100, 'wprm_recipe', 'publish', 1, 'recipe-ready', 'Ready recipe',
   'Recipe description', '', '2026-08-01 10:00:00', '2026-08-01 17:00:00',
   '2026-08-02 10:00:00', '2026-08-02 17:00:00', '', ''),
  (101, 'wprm_recipe', 'publish', 0, 'recipe-parentless', 'Parentless recipe',
   'Parentless description', '', '2026-08-01 10:00:00', '2026-08-01 17:00:00',
   '2026-08-02 10:00:00', '2026-08-02 17:00:00', '', ''),
  (102, 'wprm_recipe', 'draft', 1, 'recipe-draft', 'Draft recipe',
   'Draft description', '', '2026-08-01 10:00:00', '2026-08-01 17:00:00',
   '2026-08-02 10:00:00', '2026-08-02 17:00:00', '', ''),
  (103, 'wprm_recipe', 'publish', 1, 'recipe-no-title', '',
   'No title description', '', '2026-08-01 10:00:00', '2026-08-01 17:00:00',
   '2026-08-02 10:00:00', '2026-08-02 17:00:00', '', ''),
  (104, 'wprm_recipe', 'publish', 2, 'recipe-time-review', 'Time review',
   'Time review description', '', '2026-08-01 10:00:00', '0000-00-00 00:00:00',
   '2026-08-02 10:00:00', '0000-00-00 00:00:00', '', ''),
  (105, 'wprm_recipe', 'publish', 1, 'recipe-malformed', 'Malformed recipe',
   'Malformed description', '', '2026-08-01 10:00:00', '2026-08-01 17:00:00',
   '2026-08-02 10:00:00', '2026-08-02 17:00:00', '', ''),
  (106, 'wprm_recipe', 'publish', 1, 'recipe-missing-media', 'Missing media',
   'Missing media description', '', '2026-08-01 10:00:00', '2026-08-01 17:00:00',
   '2026-08-02 10:00:00', '2026-08-02 17:00:00', '', ''),
  (107, 'wprm_recipe', 'publish', 1, 'recipe-review-field', 'Review field',
   'Review field description', '', '2026-08-01 10:00:00', '2026-08-01 17:00:00',
   '2026-08-02 10:00:00', '2026-08-02 17:00:00', '', ''),
  (108, 'wprm_recipe', 'publish', 3, 'recipe-incomplete-group', 'Incomplete group',
   'Incomplete group description', '', '2026-08-01 10:00:00', '2026-08-01 17:00:00',
   '2026-08-02 10:00:00', '2026-08-02 17:00:00', '', ''),
  (109, 'wprm_recipe', 'publish', 5, 'recipe-ungrouped-parent', 'Ungrouped parent',
   'Ungrouped parent description', '', '2026-08-01 10:00:00', '2026-08-01 17:00:00',
   '2026-08-02 10:00:00', '2026-08-02 17:00:00', '', ''),
  (900, 'attachment', 'inherit', 0, 'fixture-image', '',
   '', '', '2026-08-01 10:00:00', '2026-08-01 17:00:00',
   '2026-08-02 10:00:00', '2026-08-02 17:00:00', '', 'image/jpeg'),
  (200, 'recipe', 'publish', 0, 'legacy-recipe', 'Legacy recipe',
   'Legacy recipe body', '', '2026-08-01 10:00:00', '2026-08-01 17:00:00',
   '2026-08-02 10:00:00', '2026-08-02 17:00:00', '', '');

INSERT INTO `wp_postmeta` (`meta_id`, `post_id`, `meta_key`, `meta_value`) VALUES
  (1, 100, 'wprm_ingredients', '[{"ingredients":[{"amount":"1 1/2","unit":"cups","name":"Flour","notes":"sifted","raw":"1 1/2 cups Flour, sifted"}],"name":"Main","uid":"g1"}]'),
  (2, 100, 'wprm_instructions', '[{"instructions":[{"text":"Mix exactly.","image":null}],"name":"Steps","uid":"s1"}]'),
  (3, 100, 'wprm_servings', '4'),
  (4, 100, 'wprm_servings_unit', 'servings'),
  (5, 100, 'wprm_prep_time', '15'),
  (6, 100, 'wprm_prep_time_zero', '0'),
  (7, 100, 'wprm_cook_time', '20'),
  (8, 100, 'wprm_cook_time_zero', '0'),
  (9, 100, 'wprm_total_time', '35'),
  (10, 100, 'wprm_custom_time', '5'),
  (11, 100, 'wprm_custom_time_label', 'Cooling'),
  (12, 100, 'wprm_notes', 'Keep covered.'),
  (13, 100, '_wp_old_slug', 'ready-old'),
  (14, 100, '_thumbnail_id', '900'),
  (15, 101, 'wprm_ingredients', '[{"ingredients":[{"amount":"½","unit":"cup","name":"Rice","notes":null}],"name":null}]'),
  (16, 101, 'wprm_instructions', '[{"instructions":[{"text":"Cook.","image":null}],"name":null}]'),
  (17, 101, 'wprm_parent_post_id', '0'),
  (18, 102, 'wprm_ingredients', '[{"ingredients":[{"amount":"1","unit":"cup","name":"Water"}]}]'),
  (19, 102, 'wprm_instructions', '[{"instructions":[{"text":"Boil.","image":null}]}]'),
  (20, 103, 'wprm_ingredients', '[{"ingredients":[{"amount":"1","unit":"cup","name":"Water"}]}]'),
  (21, 103, 'wprm_instructions', '[{"instructions":[{"text":"Boil.","image":null}]}]'),
  (22, 104, 'wprm_ingredients', '[{"ingredients":[{"amount":"2","unit":"eggs","name":"Eggs"}]}]'),
  (23, 104, 'wprm_instructions', '[{"instructions":[{"text":"Cook.","image":null}]}]'),
  (24, 105, 'wprm_ingredients', 'not-serialized'),
  (25, 105, 'wprm_instructions', '[{"instructions":[{"text":"Cook.","image":null}]}]'),
  (26, 106, 'wprm_ingredients', '[{"ingredients":[{"amount":"1","unit":"cup","name":"Water"}]}]'),
  (27, 106, 'wprm_instructions', '[{"instructions":[{"text":"Cook.","image":null}]}]'),
  (28, 106, '_thumbnail_id', '999'),
  (29, 107, 'wprm_ingredients', '[{"ingredients":[{"amount":"1","unit":"cup","name":"Water"}]}]'),
  (30, 107, 'wprm_instructions', '[{"instructions":[{"text":"Cook.","image":null}]}]'),
  (31, 107, 'wprm_video_embed', '<iframe>review</iframe>'),
  (32, 107, 'wprm_rating', 'excluded'),
  (33, 108, 'wprm_ingredients', '[{"ingredients":[{"amount":"1","unit":"cup","name":"Water"}]}]'),
  (34, 108, 'wprm_instructions', '[{"instructions":[{"text":"Cook.","image":null}]}]'),
  (35, 109, 'wprm_ingredients', '[{"ingredients":[{"amount":"1","unit":"cup","name":"Water"}]}]'),
  (36, 109, 'wprm_instructions', '[{"instructions":[{"text":"Cook.","image":null}]}]'),
  (37, 200, 'recipe_ingredients', '[{"amount":"1","unit":"cup","ingredient":"Legacy"}]'),
  (38, 200, 'recipe_instructions', '[{"description":"Legacy step","image":null}]'),
  (39, 900, '_wp_attached_file', '2026/08/fixture.jpg'),
  (40, 900, '_wp_attachment_image_alt', 'Fixture alt'),
  (41, 900, '_wp_attachment_metadata', '{"width":640,"height":480}'),
  (42, 100, 'wprm_parent_post_id', '1'),
  (43, 102, 'wprm_parent_post_id', '1'),
  (44, 103, 'wprm_parent_post_id', '1'),
  (45, 104, 'wprm_parent_post_id', '2'),
  (46, 105, 'wprm_parent_post_id', '1'),
  (47, 106, 'wprm_parent_post_id', '1'),
  (48, 107, 'wprm_parent_post_id', '0'),
  (49, 108, 'wprm_parent_post_id', '3'),
  (50, 109, 'wprm_parent_post_id', '5'),
  (51, 200, 'wpurp_recipe_signal', 'signal'),
  (52, 109, 'wprm_rating', '4.5'),
  (53, 109, 'wprm_version', '10.0'),
  (54, 100, 'wprm_equipment', 'a:1:{i:0;a:4:{s:2:"id";i:17;s:4:"name";s:17:"Fixture equipment";s:6:"amount";s:1:"1";s:5:"notes";s:0:"";}}'),
  (55, 100, 'wprm_nutrition_calories', '220'),
  (56, 100, 'wprm_nutrition_serving_size', '1'),
  (57, 100, 'wprm_nutrition_serving_unit', 'slice'),
  (58, 100, 'wprm_servings_advanced', 'a:6:{s:8:"diameter";i:0;s:6:"height";i:0;s:6:"length";i:0;s:5:"shape";s:5:"round";s:4:"unit";s:2:"cm";s:5:"width";i:0;}'),
  (59, 100, 'wprm_author_name', 'Fixture author'),
  (60, 100, 'wprm_pin_image_id', '900'),
  (61, 100, 'wprm_type', 'food'),
  (62, 100, 'wprm_video_id', '0'),
  (63, 100, 'wprm_pin_image_repin_id', '900'),
  (64, 100, 'wprm_servings_advanced_enabled', '0');

INSERT INTO `wp_terms` (`term_id`, `name`, `slug`) VALUES
  (1, 'English', 'en'),
  (2, 'French', 'fr'),
  (3, 'Recipe category', 'recipe-category'),
  (4, 'Editorial category', 'editorial-category');
INSERT INTO `wp_term_taxonomy` (`term_taxonomy_id`, `term_id`, `taxonomy`) VALUES
  (10, 1, 'language'),
  (11, 2, 'language'),
  (12, 3, 'category'),
  (13, 4, 'category'),
  (20, 1, 'post_translations');
INSERT INTO `wp_term_relationships` (`object_id`, `term_taxonomy_id`) VALUES
  (1, 10),
  (2, 11),
  (3, 10),
  (4, 11),
  (5, 11),
  (100, 12),
  (1, 13),
  (3, 20),
  (4, 20),
  (101, 10),
  (102, 10),
  (103, 10),
  (104, 11),
  (105, 10),
  (106, 10),
  (107, 10),
  (108, 10),
  (109, 11),
  (200, 10);
INSERT INTO `wp_redirection_items`
  (`id`, `url`, `match_url`, `regex`, `status`, `match_type`, `action_type`, `action_code`, `action_data`)
VALUES
  (1, '/old-fixture/', '/old-fixture/', 0, 'enabled', 'url', 'url', '301', '/new-fixture/'),
  (2, '/regex-fixture/', '/regex-fixture/', 1, 'enabled', 'regex', 'url', '301', NULL);
