CREATE TABLE `wp_options` (
  `option_id` bigint NOT NULL,
  `option_name` varchar(191) NOT NULL,
  `option_value` longtext
);
CREATE TABLE `wp_posts` (
  `ID` bigint NOT NULL,
  `post_author` bigint NOT NULL,
  `post_date` datetime NOT NULL,
  `post_date_gmt` datetime NOT NULL,
  `post_content` longtext,
  `post_title` text,
  `post_excerpt` text,
  `post_status` varchar(20) NOT NULL,
  `post_password` varchar(255) NOT NULL,
  `post_name` varchar(200) NOT NULL,
  `post_modified` datetime NOT NULL,
  `post_modified_gmt` datetime NOT NULL,
  `post_parent` bigint NOT NULL,
  `guid` varchar(255) NOT NULL,
  `post_type` varchar(20) NOT NULL,
  `post_mime_type` varchar(100) NOT NULL
);
CREATE TABLE `wp_postmeta` (
  `meta_id` bigint NOT NULL,
  `post_id` bigint NOT NULL,
  `meta_key` varchar(255),
  `meta_value` longtext
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
CREATE TABLE `wp_bwg_gallery` (
  `id` bigint NOT NULL,
  `name` varchar(255) NOT NULL,
  `published` varchar(10) NOT NULL
);
CREATE TABLE `wp_bwg_image` (
  `id` bigint NOT NULL,
  `gallery_id` bigint NOT NULL,
  `image_url` varchar(255),
  `thumb_url` varchar(255),
  `resolution` varchar(128),
  `resolution_thumb` varchar(128),
  `published` varchar(10) NOT NULL
);

INSERT INTO `wp_options` (`option_id`, `option_name`, `option_value`) VALUES
  (1, 'home', 'https://example.test'),
  (2, 'permalink_structure', '/%postname%/'),
  (3, 'polylang', 'a:5:{s:10:"force_lang";i:1;s:12:"hide_default";b:1;s:7:"rewrite";b:1;s:13:"redirect_lang";b:0;s:12:"default_lang";s:2:"en";}'),
  (4, 'wp_tiles', 'a:2:{s:12:"default_grid";s:7:"Default";s:10:"pagination";s:4:"ajax";}');

INSERT INTO `wp_posts` (`ID`, `post_author`, `post_date`, `post_date_gmt`, `post_content`, `post_title`, `post_excerpt`, `post_status`, `post_password`, `post_name`, `post_modified`, `post_modified_gmt`, `post_parent`, `guid`, `post_type`, `post_mime_type`) VALUES
  (1, 5, '2026-01-01 10:00:00', '2026-01-01 10:00:00', '<p>Source wording</p><img class="wp-image-10" src="/wp-content/uploads/2026/01/photo.jpg">[wp-tiles]<!-- wp:vendor/unknown -->', 'English page', '', 'publish', '', 'about', '2026-01-02 10:00:00', '2026-01-02 10:00:00', 0, 'https://example.test/about/', 'page', ''),
  (2, 5, '2026-01-01 10:00:00', '2026-01-01 10:00:00', '[contact-form-7 id="8"]', 'French page', '', 'publish', '', 'à-propos', '2026-01-02 10:00:00', '2026-01-02 10:00:00', 0, 'https://example.test/fr/%C3%A0-propos/', 'page', ''),
  (3, 5, '2026-01-01 10:00:00', '2026-01-01 10:00:00', '<p>Ungrouped source wording</p>', 'Ungrouped page', '', 'publish', '', 'solo', '2026-01-02 10:00:00', '2026-01-02 10:00:00', 0, 'https://example.test/solo/', 'page', ''),
  (4, 5, '2026-01-01 10:00:00', '2026-01-01 10:00:00', '<p>Private source wording</p>', 'Private page', '', 'private', '', 'private-page', '2026-01-02 10:00:00', '2026-01-02 10:00:00', 0, 'https://example.test/private-page/', 'page', ''),
  (10, 5, '2026-01-01 10:00:00', '2026-01-01 10:00:00', '', '', '', 'inherit', '', 'photo', '2026-01-02 10:00:00', '2026-01-02 10:00:00', 0, 'https://example.test/wp-content/uploads/2026/01/photo.jpg', 'attachment', 'image/jpeg');

INSERT INTO `wp_postmeta` (`meta_id`, `post_id`, `meta_key`, `meta_value`) VALUES
  (1, 1, '_thumbnail_id', '10'),
  (2, 10, '_wp_attached_file', '2026/01/photo.jpg'),
  (3, 10, '_wp_attachment_image_alt', 'Source alt text'),
  (4, 10, '_wp_attachment_metadata', 'a:2:{s:5:"width";i:800;s:6:"height";i:600;}');

INSERT INTO `wp_terms` (`term_id`, `name`, `slug`) VALUES
  (1, 'Test English Locale', 'en'),
  (2, 'Test French Locale', 'fr');
INSERT INTO `wp_term_taxonomy` (`term_taxonomy_id`, `term_id`, `taxonomy`) VALUES
  (10, 1, 'language'),
  (11, 2, 'language'),
  (100, 1, 'post_translations');
INSERT INTO `wp_term_relationships` (`object_id`, `term_taxonomy_id`) VALUES
  (1, 10),
  (2, 11),
  (3, 10),
  (4, 10),
  (1, 100),
  (2, 100);

INSERT INTO `wp_bwg_gallery` (`id`, `name`, `published`) VALUES
  (300, 'Private gallery wording', '1');
INSERT INTO `wp_bwg_image` (`id`, `gallery_id`, `image_url`, `thumb_url`, `resolution`, `resolution_thumb`, `published`) VALUES
  (301, 300, 'photo-gallery/album/original.jpg', 'photo-gallery/album/thumb.jpg', '1200 x 800 px', '300x200', '1');
