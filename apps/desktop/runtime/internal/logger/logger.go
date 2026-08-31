package logger

import (
	"context"
	"log"
)

func Debugf(_ context.Context, format string, args ...any) { log.Printf("DEBUG "+format, args...) }
func Infof(_ context.Context, format string, args ...any)  { log.Printf("INFO "+format, args...) }
func Warnf(_ context.Context, format string, args ...any)  { log.Printf("WARN "+format, args...) }
func Errorf(_ context.Context, format string, args ...any) { log.Printf("ERROR "+format, args...) }
