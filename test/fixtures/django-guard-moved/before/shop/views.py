from django.contrib.auth.decorators import login_required
from django.http import HttpResponse
from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView


@login_required
def profile(request):
    return HttpResponse("me")


class Orders(APIView):
    permission_classes = [IsAuthenticated]
