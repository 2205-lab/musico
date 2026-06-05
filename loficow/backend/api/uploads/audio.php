<?php
$user = requireAuth();

if (!isset($_FILES['audio'])) error('No file uploaded');

$file     = $_FILES['audio'];
$allowed  = ['audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/ogg','audio/flac'];
$maxBytes = 50 * 1024 * 1024; // 50MB

if ($file['size'] > $maxBytes) error('File too large (max 50MB)');

$finfo = new finfo(FILEINFO_MIME_TYPE);
$mime  = $finfo->file($file['tmp_name']);
if (!in_array($mime, $allowed)) error('Invalid file type. Allowed: MP3, WAV, OGG, FLAC');

$ext      = pathinfo($file['name'], PATHINFO_EXTENSION);
$filename = bin2hex(random_bytes(16)) . '.' . strtolower($ext);
$dir      = UPLOAD_PATH . 'audio/';
if (!is_dir($dir)) mkdir($dir, 0755, true);
$dest     = $dir . $filename;

if (!move_uploaded_file($file['tmp_name'], $dest)) error('Upload failed', 500);

$url = BASE_URL . '/uploads/audio/' . $filename;
json(['url' => $url, 'filename' => $filename]);
