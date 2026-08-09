CREATE TABLE `wp_posts` (
  `ID` bigint NOT NULL,
  `post_type` varchar(20) NOT NULL,
  `post_content` longtext NOT NULL
);
CREATE TABLE `wp_postmeta` (
  `meta_id` bigint NOT NULL,
  `post_id` bigint NOT NULL,
  `meta_key` varchar(255) NOT NULL,
  `meta_value` longtext NOT NULL
);
CREATE TABLE `wp_terms` (
  `term_id` bigint NOT NULL,
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
  `action_type` varchar(20) NOT NULL,
  `action_code` varchar(10) NOT NULL
);
CREATE TABLE `wp_redirection_groups` (
  `id` bigint NOT NULL
);
CREATE TABLE `wp_bwg_gallery` (`id` bigint NOT NULL);
CREATE TABLE `wp_bwg_image` (
  `id` bigint NOT NULL,
  `gallery_id` bigint NOT NULL
);
CREATE TABLE `wp_bwg_album` (`id` bigint NOT NULL);
CREATE TABLE `wp_bwg_shortcode` (`id` bigint NOT NULL);
CREATE TABLE `wp_bwg_album_gallery` (
  `album_id` bigint NOT NULL,
  `alb_gal_id` bigint NOT NULL,
  `is_album` tinyint NOT NULL
);
CREATE TABLE `wp_wprm_recipes` (`id` bigint NOT NULL);
CREATE TABLE `wp_urp_recipe` (`id` bigint NOT NULL);
CREATE TABLE `wp_wprm_ratings` (
  `id` bigint NOT NULL,
  `recipe_id` bigint NOT NULL,
  `post_id` bigint NOT NULL
);

INSERT INTO `wp_posts` (`ID`, `post_type`, `post_content`) VALUES
(1, 'page', 'Plain page'),
(2, 'wprm_recipe', '[gallery id="701"] [gallery ids="801, 802, invalid"]'),
(3, 'recipe', 'No gallery'),
(4, 'attachment', '');
INSERT INTO `wp_postmeta` (`meta_id`, `post_id`, `meta_key`, `meta_value`) VALUES
(1, 4, '_wp_attached_file', '2026/08/photo.jpg'),
(2, 2, '_thumbnail_id', '4'),
(3, 2, '_wprm_recipe_id', '200'),
(4, 3, 'wpurp_recipe_image_id', '4'),
(5, 3, '_wp_old_slug', 'old-page'),
(6, 1, '_pll_language', 'en');
INSERT INTO `wp_terms` (`term_id`, `slug`) VALUES
(10, 'en'),
(11, 'fr'),
(12, 'ru'),
(13, 'dessert'),
(14, 'pll_en'),
(15, 'pll_fr'),
(16, 'pll_ru'),
(17, 'es'),
(18, 'pll_es'),
(19, 'dessert-fr'),
(20, 'post-group'),
(21, 'term-group'),
(22, 'orphan-term-group');
INSERT INTO `wp_term_taxonomy` (`term_taxonomy_id`, `term_id`, `taxonomy`) VALUES
(20, 10, 'language'),
(21, 11, 'language'),
(22, 12, 'language'),
(23, 20, 'post_translations'),
(24, 13, 'category'),
(25, 17, 'language'),
(26, 14, 'term_language'),
(27, 15, 'term_language'),
(28, 16, 'term_language'),
(29, 18, 'term_language'),
(30, 21, 'term_translations'),
(31, 22, 'term_translations');
INSERT INTO `wp_term_relationships` (`object_id`, `term_taxonomy_id`) VALUES
(1, 20),
(2, 21),
(3, 22),
(2, 23),
(3, 23),
(2, 24),
(13, 26),
(19, 27),
(13, 30),
(19, 30);
INSERT INTO `wp_redirection_groups` (`id`) VALUES
(30);
INSERT INTO `wp_redirection_items` (`id`, `action_type`, `action_code`) VALUES
(31, 'url', '301');
INSERT INTO `wp_bwg_gallery` (`id`) VALUES
(701);
INSERT INTO `wp_bwg_image` (`id`, `gallery_id`) VALUES
(702, 701);
INSERT INTO `wp_bwg_album` (`id`) VALUES
(703),
(704);
INSERT INTO `wp_bwg_shortcode` (`id`) VALUES
(704);
INSERT INTO `wp_bwg_album_gallery` (`album_id`, `alb_gal_id`, `is_album`) VALUES
(703, 701, 0),
(703, 704, 1),
(703, NULL, 0);
INSERT INTO `wp_wprm_recipes` (`id`) VALUES
(200);
INSERT INTO `wp_urp_recipe` (`id`) VALUES
(300);
INSERT INTO `wp_wprm_ratings` (`id`, `recipe_id`, `post_id`) VALUES
(400, 200, 2);
