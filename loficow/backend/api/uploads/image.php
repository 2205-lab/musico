<?php
$user = requireAuth();

if (!isset($_FILES['image'])) error('No file uploaded');

$file    = $_FILES['image'];
$allowed = ['image/jpeg','image/png','image/webp','image/gif'];
$maxSize = 5 * 1024 * 1024; // 5MB

if ($file['size'] > $maxSize) error('Image too large (max 5MB)');

$finfo = new finfo(FILEINFO_MIME_TYPE);
$mime  = $finfo->file($file['tmp_name']);
if (!in_array($mime, $allowed)) error('Invalid image type. Allowed: JPG, PNG, WebP, GIF');

$ext      = ['image/jpeg'=>'jpg','image/png'=>'png','image/webp'=>'webp','image/gif'=>'gif'][$mime];
$folder   = $_GET['type'] === 'avatar' ? 'avatars' : 'covers';
$filename = bin2hex(random_bytes(16)) . '.' . $ext;
$dir      = UPLOAD_PATH . $folder . '/';
if (!is_dir($dir)) mkdir($dir, 0755, true);
$dest     = $dir . $filename;

if (!move_uploaded_file($file['tmp_name'], $dest)) error('Upload failed', 500);

$url = BASE_URL . '/uploads/' . $folder . '/' . $filename;
json(['url' => $url]);
