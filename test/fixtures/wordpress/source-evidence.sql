CREATE TABLE `wp_posts` (
  `ID` bigint NOT NULL,
  `post_type` varchar(32) NOT NULL,
  `post_status` varchar(20) NOT NULL,
  `post_parent` bigint NOT NULL,
  `post_content` longtext NOT NULL,
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
  `slug` varchar(200) NOT NULL
);
CREATE TABLE `wp_term_taxonomy` (
  `term_taxonomy_id` bigint NOT NULL,
  `term_id` bigint NOT NULL,
  `taxonomy` varchar(32) NOT NULL,
  `parent` bigint NOT NULL
);
CREATE TABLE `wp_term_relationships` (
  `object_id` bigint NOT NULL,
  `term_taxonomy_id` bigint NOT NULL
);
CREATE TABLE `wp_redirection_items` (
  `id` bigint NOT NULL,
  `url` varchar(255) NOT NULL,
  `match_url` varchar(255) NOT NULL,
  `regex` tinyint NOT NULL,
  `status` varchar(20) NOT NULL,
  `match_type` varchar(20) NOT NULL,
  `action_type` varchar(20) NOT NULL,
  `action_code` varchar(10) NOT NULL,
  `action_data` longtext NULL,
  `match_data` longtext NULL
);
CREATE TABLE `wp_bwg_gallery` (
  `id` bigint NOT NULL,
  `published` tinyint NOT NULL
);
CREATE TABLE `wp_bwg_image` (
  `id` bigint NOT NULL,
  `gallery_id` bigint NOT NULL,
  `published` tinyint NOT NULL,
  `image_url` varchar(255) NULL,
  `thumb_url` varchar(255) NULL,
  `alt` text NULL,
  `description` text NULL
);
CREATE TABLE `wp_bwg_album` (
  `id` bigint NOT NULL,
  `published` tinyint NOT NULL
);
CREATE TABLE `wp_bwg_album_gallery` (
  `album_id` bigint NOT NULL,
  `alb_gal_id` bigint NULL,
  `is_album` tinyint NULL
);
CREATE TABLE `wp_bwg_shortcode` (
  `id` bigint NOT NULL
);

INSERT INTO `wp_posts`
  (`ID`, `post_type`, `post_status`, `post_parent`, `post_content`, `post_mime_type`)
VALUES
  (1, 'page', 'publish', 0, 'Editorial sentinel title [wprm-recipe id="2"]', ''),
  (2, 'wprm_recipe', 'publish', 1, '[wprm-recipe id=''101'']', ''),
  (3, 'wprm_recipe', 'publish', 99, '[wprm-recipe id="999"]', ''),
  (4, 'recipe', 'publish', 0, 'WPUR sentinel body', ''),
  (5, 'post', 'publish', 0, 'Signal post', ''),
  (6, 'attachment', 'inherit', 0, '', 'image/jpeg'),
  (7, 'attachment', 'inherit', 0, '', 'image/jpeg'),
  (8, 'page', 'publish', 0, 'Translation page', ''),
  (9, 'attachment', 'inherit', 0, '', 'image/jpeg');

INSERT INTO `wp_postmeta` (`meta_id`, `post_id`, `meta_key`, `meta_value`) VALUES
  (1, 2, 'wprm_ingredients', '[{"ingredients":[{"uid":"u1","amount":"1","unit":"cup","name":"Sugar","mysteryNested":"sentinel"}],"name":"Main","uid":"g1"}]'),
  (2, 2, 'wprm_instructions', '[{"instructions":[{"uid":"s1","text":"Bake sentinel","image":"6","unknownStep":"sentinel"}],"name":"Steps","uid":"g2"}]'),
  (3, 2, 'wprm_parent_post_id', '1'),
  (4, 2, '_thumbnail_id', '6'),
  (5, 3, 'wprm_ingredients', 'a:1:{i:0;a:3:{s:11:"ingredients";a:0:{}s:4:"name";s:4:"Side";s:3:"uid";s:2:"g3";}}'),
  (6, 3, 'wprm_instructions', 'a:1:{'),
  (7, 3, 'wprm_parent_post_id', '99'),
  (8, 4, 'recipe_title', 'WPUR sentinel title'),
  (9, 4, 'recipe_ingredients', '[{"amount":"2","unit":"cups","ingredient":"Flour","notes":"note","group":"Base","ingredient_id":"2","amount_normalized":"2"}]'),
  (10, 4, 'recipe_instructions', '[{"description":"Bake","image":"7","group":"Base"}]'),
  (11, 4, 'recipe_alternate_image', '7'),
  (12, 5, 'wpurp_recipe_signal', 'serialized sentinel value'),
  (13, 6, '_wp_attached_file', '2026/08/hero.jpg'),
  (14, 6, '_wp_attachment_image_alt', 'alt sentinel email@example.invalid'),
  (15, 6, '_wp_attachment_metadata', '{"width":800,"height":600,"sizes":{"thumbnail":{"width":150}}}'),
  (16, 7, '_wp_attached_file', '2026/08/step.jpg'),
  (17, 7, '_wp_attachment_image_alt', NULL),
  (18, 7, '_wp_attachment_metadata', 'not-json'),
  (19, 8, '_wp_old_slug', 'sentinel-slug'),
  (20, 4, 'recipe_description', 'sentinel description and URL https://sentinel.invalid');

INSERT INTO `wp_terms` (`term_id`, `slug`) VALUES
  (10, 'en'),
  (11, 'fr'),
  (12, 'ru'),
  (20, 'dessert-sentinel'),
  (21, 'dessert-fr-sentinel'),
  (22, 'empty-term'),
  (40, 'pll_en'),
  (41, 'pll_fr');

INSERT INTO `wp_term_taxonomy` (`term_taxonomy_id`, `term_id`, `taxonomy`, `parent`) VALUES
  (30, 10, 'language', 0),
  (31, 11, 'language', 0),
  (32, 12, 'language', 0),
  (33, 40, 'term_language', 0),
  (34, 41, 'term_language', 0),
  (35, 20, 'term_translations', 0),
  (36, 22, 'term_translations', 0),
  (37, 20, 'category', 0),
  (38, 21, 'category', 0),
  (39, 20, 'post_tag', 0),
  (40, 20, 'post_translations', 0),
  (41, 21, 'post_translations', 0);

INSERT INTO `wp_term_relationships` (`object_id`, `term_taxonomy_id`) VALUES
  (1, 30),
  (2, 31),
  (3, 32),
  (8, 31),
  (20, 35),
  (21, 35),
  (20, 33),
  (21, 34),
  (1, 40),
  (3, 41);

INSERT INTO `wp_redirection_items`
  (`id`, `url`, `match_url`, `regex`, `status`, `match_type`, `action_type`, `action_code`, `action_data`, `match_data`)
VALUES
  (1, '/old-recipe/', '/old-recipe/', 0, 'enabled', 'url', 'url', '301', '/new-recipe/', NULL),
  (2, '/old-json/', '/old-json/', 0, 'enabled', 'url', 'url', '301', '{"url":"/json-target/"}', NULL),
  (3, '/old-malformed/', '/old-malformed/', 0, 'enabled', 'url', 'url', '301', 'a:1:{', NULL),
  (4, 'https://sentinel.invalid/source', 'https://sentinel.invalid/source', 1, 'disabled', 'regex', 'url', '302', 'https://sentinel.invalid/target', NULL),
  (5, '/missing-target/', '/missing-target/', 0, 'enabled', 'url', 'url', '301', NULL, NULL);

INSERT INTO `wp_bwg_gallery` (`id`, `published`) VALUES
  (701, 1);
INSERT INTO `wp_bwg_image`
  (`id`, `gallery_id`, `published`, `image_url`, `thumb_url`, `alt`, `description`)
VALUES
  (801, 701, 1, 'imported_from_media_libray/hero.jpg', 'imported_from_media_libray/thumb/hero.jpg', 'gallery alt sentinel', 'gallery description sentinel'),
  (802, 999, 1, '/missing.jpg', '/missing-thumb.jpg', NULL, NULL),
  (803, 701, 1, '../unsafe.jpg', NULL, NULL, NULL);
INSERT INTO `wp_bwg_album` (`id`, `published`) VALUES
  (901, 1),
  (902, 1);
INSERT INTO `wp_bwg_album_gallery` (`album_id`, `alb_gal_id`, `is_album`) VALUES
  (901, 701, 0),
  (901, 902, 1),
  (901, 999, 0),
  (901, NULL, 0);
INSERT INTO `wp_bwg_shortcode` (`id`) VALUES
  (1001);
