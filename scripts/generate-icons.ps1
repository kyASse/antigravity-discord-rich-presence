New-Item -ItemType Directory -Force -Path "assets"

Copy-Item "C:/Users/akyas/.gemini/antigravity/brain/ca4f9282-4e7c-4246-8d02-989d7116869e/scratch/icon.png" "assets/antigravity-transparent.png"

Add-Type -AssemblyName System.Drawing

$bmp = New-Object System.Drawing.Bitmap(512, 512)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

# Rounded rectangle squircle
$radius = 110
$x = 20
$y = 20
$width = 472
$height = 472

$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc($x, $y, $radius, $radius, 180, 90)
$path.AddArc($x + $width - $radius, $y, $radius, $radius, 270, 90)
$path.AddArc($x + $width - $radius, $y + $height - $radius, $radius, $radius, 0, 90)
$path.AddArc($x, $y + $height - $radius, $radius, $radius, 90, 90)
$path.CloseFigure()

$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.FillPath($brush, $path)

# Draw original logo inside
$orig = [System.Drawing.Bitmap]::FromFile((Resolve-Path "assets/antigravity-transparent.png").Path)
$g.DrawImage($orig, 66, 66, 380, 380)

$orig.Dispose()
$brush.Dispose()
$path.Dispose()
$g.Dispose()

$bmp.Save((Resolve-Path "assets").Path + "/antigravity-white-squircle.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output "Assets created in assets/ successfully"
